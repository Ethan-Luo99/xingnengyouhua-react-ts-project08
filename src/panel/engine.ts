import type { Ctx, FnEntry, RecomputeResult } from './types.ts'

export class CycleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CycleError'
  }
}

interface Node {
  entry: FnEntry
  /** 注册顺序号，拓扑排序的同层 tie-break 依据 */
  index: number
}

/**
 * 增量重算引擎。
 *
 * 设计决策（对应需求第 4 条）：只信显式 reads/writes 声明，不用 Proxy 做运行时读追踪。
 * 理由：
 *  1. Proxy 包装会改变 ctx 的对象身份（ctx !== proxiedCtx），破坏"共享单个可变 ctx"的语义，
 *     函数若把 ctx 引用存到闭包/外部，读追踪立即失效且无声出错；
 *  2. 热路径上每次读都过 Proxy trap，600 函数 × 每函数字段读的额外开销不可忽略；
 *  3. 显式声明可静态审计、可在注册期做环检测，隐式追踪做不到。
 * 降级策略：
 *  - reads 未声明（undefined）的函数进入 alwaysDirty 集合，每个批次保守重算，正确性优先；
 *  - 提供 auditDeclarations()（Proxy 实现，仅 dev/测试用）：真实执行各函数并记录实际读取，
 *    与声明比对，发现未声明的隐式依赖即报错，把 Proxy 从"运行时兜底"降级为"开发期审计"。
 */
export class IncrementalEngine {
  private nodes = new Map<string, Node>()
  private insertionCounter = 0
  /** ctx 字段 -> 写入它的函数 */
  private writerOf = new Map<string, string>()
  /** ctx 字段 -> 读取它的函数集合 */
  private readersOf = new Map<string, Set<string>>()
  /** 函数 -> 直接下游函数集合 */
  private downstream = new Map<string, Set<string>>()
  /** 未声明 reads 的函数：保守策略，每批必算 */
  private alwaysDirty = new Set<string>()
  /** 注册后从未执行过的函数 */
  private neverComputed = new Set<string>()
  /** 结构变更（注销）导致的待重算函数 */
  private pendingDirtyFns = new Set<string>()
  private topoDirty = true
  private topoOrder: string[] = []
  private cachedOutputs = new Map<string, unknown>()
  private fullRecomputeNeeded = true
  /** HMR/失效代数，仅供外部观测 */
  generation = 0
  readonly ctx: Ctx

  constructor(ctx: Ctx = {}) {
    this.ctx = ctx
  }

  get size(): number {
    return this.nodes.size
  }

  register(entry: FnEntry): void {
    if (this.nodes.has(entry.name)) {
      throw new Error(`duplicate registration: ${entry.name}`)
    }
    for (const field of entry.meta.writes) {
      const owner = this.writerOf.get(field)
      if (owner !== undefined) {
        throw new Error(`field "${field}" already written by "${owner}"`)
      }
    }

    const undo: Array<() => void> = []
    const rollback = () => {
      for (let i = undo.length - 1; i >= 0; i--) undo[i]()
      this.topoDirty = true
    }

    try {
      this.nodes.set(entry.name, { entry, index: this.insertionCounter++ })
      undo.push(() => this.nodes.delete(entry.name))

      for (const field of entry.meta.writes) {
        this.writerOf.set(field, entry.name)
        undo.push(() => this.writerOf.delete(field))
        // 前向引用：已有函数读了该字段（当时还是"输入"），现在补上 本函数->读者 的边
        for (const reader of this.readersOf.get(field) ?? []) {
          this.addEdge(entry.name, reader)
          undo.push(() => this.removeEdge(entry.name, reader))
        }
      }

      if (entry.meta.reads === undefined) {
        this.alwaysDirty.add(entry.name)
        undo.push(() => this.alwaysDirty.delete(entry.name))
      } else {
        for (const field of entry.meta.reads) {
          let set = this.readersOf.get(field)
          if (!set) {
            set = new Set()
            this.readersOf.set(field, set)
            undo.push(() => this.readersOf.delete(field))
          }
          set.add(entry.name)
          undo.push(() => set.delete(entry.name))
          const writer = this.writerOf.get(field)
          if (writer !== undefined) {
            this.addEdge(writer, entry.name)
            undo.push(() => this.removeEdge(writer, entry.name))
          }
        }
      }

      this.neverComputed.add(entry.name)
      undo.push(() => this.neverComputed.delete(entry.name))

      this.topoDirty = true
      this.rebuildTopo() // 成环在此抛出，触发回滚
    } catch (err) {
      rollback()
      throw err
    }
  }

  /** 注销函数：增量重建 DAG，下游闭包标记为待重算，其写入字段从 ctx 清除 */
  unregister(name: string): void {
    const node = this.nodes.get(name)
    if (!node) return
    for (const field of node.entry.meta.writes) {
      this.writerOf.delete(field)
      delete this.ctx[field]
    }
    if (node.entry.meta.reads) {
      for (const field of node.entry.meta.reads) {
        const set = this.readersOf.get(field)
        if (set) {
          set.delete(name)
          if (set.size === 0) this.readersOf.delete(field)
        }
      }
    }
    // 收集下游闭包（在删边之前）
    const affected = this.collectDownstream(name)
    for (const n of affected) this.pendingDirtyFns.add(n)
    // 删边
    for (const set of this.downstream.values()) set.delete(name)
    this.downstream.delete(name)
    this.nodes.delete(name)
    this.alwaysDirty.delete(name)
    this.neverComputed.delete(name)
    this.cachedOutputs.delete(name)
    this.topoDirty = true
  }

  /** HMR 热替换函数实现后调用：缓存与 DAG 计算结果整体失效，下一批全量重算 */
  invalidateAll(): void {
    this.cachedOutputs.clear()
    this.fullRecomputeNeeded = true
    this.generation++
  }

  /** 写入输入字段，返回实际发生变化的字段（相同值不触发 dirty，StrictMode 双调用安全） */
  applyInputs(patch: Ctx): string[] {
    const changed: string[] = []
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.is(this.ctx[key], value)) {
        this.ctx[key] = value
        changed.push(key)
      }
    }
    return changed
  }

  recompute(changedFields: Iterable<string>): RecomputeResult {
    this.ensureTopo()
    const start = performance.now()
    let executed: string[]

    if (this.fullRecomputeNeeded) {
      executed = [...this.topoOrder]
      this.fullRecomputeNeeded = false
    } else {
      const affected = new Set<string>(this.alwaysDirty)
      for (const n of this.neverComputed) affected.add(n)
      for (const n of this.pendingDirtyFns) affected.add(n)
      const stack: string[] = []
      for (const field of changedFields) {
        for (const reader of this.readersOf.get(field) ?? []) stack.push(reader)
      }
      while (stack.length > 0) {
        const name = stack.pop() as string
        if (affected.has(name) || !this.nodes.has(name)) continue
        affected.add(name)
        for (const next of this.downstream.get(name) ?? []) stack.push(next)
      }
      executed = this.topoOrder.filter((n) => affected.has(n))
    }
    this.pendingDirtyFns.clear()

    for (const name of executed) {
      const node = this.nodes.get(name)
      if (!node) continue
      const output = node.entry.fn(this.ctx)
      this.cachedOutputs.set(name, output)
      this.neverComputed.delete(name)
    }

    return {
      executed,
      durationMs: performance.now() - start,
      outputs: Object.fromEntries(this.cachedOutputs),
    }
  }

  /**
   * 开发期审计（Proxy 仅在此使用，不进运行时热路径）：
   * 在 ctx 的克隆上真实执行每个函数，记录实际读取的字段，与声明的 reads 比对。
   * 返回存在隐式依赖的函数清单；空数组表示声明完备。
   */
  auditDeclarations(): Array<{ name: string; undeclared: string[] }> {
    const problems: Array<{ name: string; undeclared: string[] }> = []
    for (const [name, node] of this.nodes) {
      const declared = node.entry.meta.reads
      if (declared === undefined) continue // 未声明的走保守重算，不参与审计
      const actual = new Set<string>()
      const scratch: Ctx = { ...this.ctx }
      const proxy = new Proxy(scratch, {
        get(target, prop) {
          if (typeof prop === 'string') actual.add(prop)
          return Reflect.get(target, prop)
        },
      })
      node.entry.fn(proxy)
      const declaredSet = new Set([...declared, ...node.entry.meta.writes])
      const undeclared = [...actual].filter((k) => !declaredSet.has(k))
      if (undeclared.length > 0) problems.push({ name, undeclared })
    }
    return problems
  }

  /** 仅供测试/调试：当前拓扑序 */
  getTopoOrder(): string[] {
    this.ensureTopo()
    return [...this.topoOrder]
  }

  private addEdge(from: string, to: string): void {
    let set = this.downstream.get(from)
    if (!set) {
      set = new Set()
      this.downstream.set(from, set)
    }
    set.add(to)
  }

  private removeEdge(from: string, to: string): void {
    const set = this.downstream.get(from)
    if (set) {
      set.delete(to)
      if (set.size === 0) this.downstream.delete(from)
    }
  }

  private collectDownstream(name: string): Set<string> {
    const result = new Set<string>()
    const stack = [...(this.downstream.get(name) ?? [])]
    while (stack.length > 0) {
      const n = stack.pop() as string
      if (result.has(n)) continue
      result.add(n)
      for (const next of this.downstream.get(n) ?? []) stack.push(next)
    }
    return result
  }

  private ensureTopo(): void {
    if (this.topoDirty) this.rebuildTopo()
  }

  /**
   * Kahn 拓扑排序，同层按注册顺序号取最小者。
   * 当依赖图不含"回边"（读者先于写者注册）时，结果与原 Map 插入序完全一致，
   * 这正是顺序敏感语义得以保持的依据。
   */
  private rebuildTopo(): void {
    const indegree = new Map<string, number>()
    for (const name of this.nodes.keys()) indegree.set(name, 0)
    for (const targets of this.downstream.values()) {
      for (const to of targets) {
        if (indegree.has(to)) indegree.set(to, (indegree.get(to) as number) + 1)
      }
    }
    const indexOf = (name: string) => (this.nodes.get(name) as Node).index
    const ready: string[] = []
    for (const [name, deg] of indegree) if (deg === 0) ready.push(name)
    ready.sort((a, b) => indexOf(a) - indexOf(b))

    const order: string[] = []
    while (ready.length > 0) {
      const name = ready.shift() as string
      order.push(name)
      for (const next of this.downstream.get(name) ?? []) {
        const deg = (indegree.get(next) as number) - 1
        indegree.set(next, deg)
        if (deg === 0) {
          // 按注册序插入，保持 ready 有序
          let lo = 0
          let hi = ready.length
          while (lo < hi) {
            const mid = (lo + hi) >> 1
            if (indexOf(ready[mid]) < indexOf(next)) lo = mid + 1
            else hi = mid
          }
          ready.splice(lo, 0, next)
        }
      }
    }
    if (order.length !== this.nodes.size) {
      const remaining = [...indegree.entries()].filter(([, d]) => d > 0).map(([n]) => n)
      throw new CycleError(`dependency cycle detected involving: ${remaining.join(', ')}`)
    }
    this.topoOrder = order
    this.topoDirty = false
  }
}
