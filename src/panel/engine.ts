import type { Ctx, FnEntry, Registry, RunStats } from './types.ts'

export class CycleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CycleError'
  }
}

export class OrderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrderError'
  }
}

interface InternalEntry {
  fn: FnEntry['fn']
  declaredReads: string[]
  declaredWrites: string[]
  dynamicReads: Set<string>
  dynamicWrites: Set<string>
  allReads: Set<string>
  allWrites: Set<string>
  alwaysDirty: boolean
}

export interface EngineOptions {
  /** Proxy 读追踪兜底（默认开启）；关闭后只信显式声明 */
  trackReadsWithProxy?: boolean
  onImplicitDep?: (fnName: string, field: string) => void
}

interface RunState {
  version: number
  forceAll: boolean
  changed: Set<string>
  forced: Set<string>
  overlay: Map<string, unknown>
  cursor: IterableIterator<[string, InternalEntry]>
  stats: RunStats
  startedAt: number
  chunkStart: number
}

const yieldToMain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const addToMulti = (index: Map<string, Set<string>>, field: string, name: string): void => {
  let set = index.get(field)
  if (!set) {
    set = new Set()
    index.set(field, set)
  }
  set.add(name)
}

export class IncrementalEngine {
  readonly ctx: Ctx
  private readonly entries = new Map<string, InternalEntry>()
  private readonly readers = new Map<string, Set<string>>()
  private readonly writers = new Map<string, string>()
  private version = 0
  private committedVersion = 0
  private fullInvalidation = true
  private readonly pendingFields = new Set<string>()
  private readonly pendingFns = new Set<string>()
  private readonly proxyTracking: boolean
  private readonly onImplicitDep?: (fnName: string, field: string) => void
  private lastStats: RunStats = {
    version: 0,
    executed: 0,
    skipped: 0,
    durationMs: 0,
    aborted: false,
    implicitDepsFound: 0,
  }
  private readonly listeners = new Set<() => void>()
  private inFlight: Promise<RunStats> | null = null

  constructor(registry: Registry, ctx: Ctx = {}, options: EngineOptions = {}) {
    this.ctx = ctx
    this.proxyTracking = options.trackReadsWithProxy ?? true
    this.onImplicitDep = options.onImplicitDep
    this.loadRegistry(registry)
  }

  get size(): number {
    return this.entries.size
  }

  get committed(): number {
    return this.committedVersion
  }

  getStats(): RunStats {
    return this.lastStats
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  private emit(): void {
    for (const cb of [...this.listeners]) cb()
  }

  // ---- 注册表装载 / HMR 整体替换 ----

  private loadRegistry(registry: Registry): void {
    this.entries.clear()
    this.readers.clear()
    this.writers.clear()
    for (const [name, entry] of registry) this.addEntry(name, entry)
    this.assertAcyclic()
    this.fullInvalidation = true
  }

  /** HMR：函数实现被热替换后调用，缓存与 DAG 整体失效，下一轮全量重算 */
  replaceRegistry(registry: Registry): void {
    this.loadRegistry(registry)
    this.pendingFields.clear()
    this.pendingFns.clear()
    this.version++ // 使在飞批次立即过期
  }

  // ---- 运行时动态增删 ----

  registerFunction(name: string, entry: FnEntry): void {
    if (this.entries.has(name)) this.unregisterFunction(name)
    for (const w of entry.writes) {
      const owner = this.writers.get(w)
      if (owner) {
        throw new Error(`字段 "${w}" 已有写入者 "${owner}"，拒绝注册 "${name}"`)
      }
    }
    this.addEntry(name, entry)
    try {
      this.assertNoCycleThrough(name)
      this.assertOrderCompatible(name)
    } catch (err) {
      this.removeEntry(name) // 回滚：拒绝注册，不留残骸
      throw err
    }
    this.pendingFns.add(name)
  }

  unregisterFunction(name: string): boolean {
    const entry = this.entries.get(name)
    if (!entry) return false
    this.removeEntry(name)
    // 被删函数的写字段标记为已变化：下一轮其下游按全量语义重算
    for (const w of entry.allWrites) this.pendingFields.add(w)
    this.pendingFns.delete(name)
    return true
  }

  private addEntry(name: string, entry: FnEntry): void {
    const internal: InternalEntry = {
      fn: entry.fn,
      declaredReads: [...entry.reads],
      declaredWrites: [...entry.writes],
      dynamicReads: new Set(),
      dynamicWrites: new Set(),
      allReads: new Set(entry.reads),
      allWrites: new Set(entry.writes),
      alwaysDirty: false,
    }
    this.entries.set(name, internal)
    for (const r of internal.allReads) addToMulti(this.readers, r, name)
    for (const w of internal.allWrites) this.writers.set(w, name)
  }

  private removeEntry(name: string): void {
    const entry = this.entries.get(name)
    if (!entry) return
    for (const r of entry.allReads) this.readers.get(r)?.delete(name)
    for (const w of entry.allWrites) {
      if (this.writers.get(w) === name) this.writers.delete(w)
    }
    this.entries.delete(name)
  }

  // ---- 环检测与顺序兼容 ----

  private assertAcyclic(): void {
    const indegree = new Map<string, number>()
    for (const name of this.entries.keys()) indegree.set(name, 0)
    for (const [field, readers] of this.readers) {
      const writer = this.writers.get(field)
      if (!writer) continue
      for (const reader of readers) {
        if (reader === writer) continue // 允许函数读自己上一轮写出的字段
        indegree.set(reader, (indegree.get(reader) ?? 0) + 1)
      }
    }
    const queue: string[] = []
    for (const [name, degree] of indegree) if (degree === 0) queue.push(name)
    let visited = 0
    while (queue.length > 0) {
      const current = queue.pop() as string
      visited++
      const entry = this.entries.get(current)
      if (!entry) continue
      for (const w of entry.allWrites) {
        for (const reader of this.readers.get(w) ?? []) {
          if (reader === current) continue
          const degree = (indegree.get(reader) ?? 0) - 1
          indegree.set(reader, degree)
          if (degree === 0) queue.push(reader)
        }
      }
    }
    if (visited < this.entries.size) {
      throw new CycleError('注册表存在依赖环，拒绝装载')
    }
  }

  private assertNoCycleThrough(start: string): void {
    const visited = new Set<string>()
    const stack = [start]
    while (stack.length > 0) {
      const current = stack.pop() as string
      const entry = this.entries.get(current)
      if (!entry) continue
      for (const w of entry.allWrites) {
        for (const reader of this.readers.get(w) ?? []) {
          if (reader === current) continue // 自依赖：顺序语义下合法
          if (reader === start) {
            throw new CycleError(`注册 "${start}" 会形成依赖环，拒绝注册`)
          }
          if (!visited.has(reader)) {
            visited.add(reader)
            stack.push(reader)
          }
        }
      }
    }
  }

  private assertOrderCompatible(name: string): void {
    const entry = this.entries.get(name)
    if (!entry) return
    // 新函数追加在插入序末尾：它写出的字段不能被任何已注册函数读取，
    // 否则拓扑序无法与插入序等价，顺序敏感语义无法保证。
    for (const w of entry.allWrites) {
      for (const reader of this.readers.get(w) ?? []) {
        if (reader !== name) {
          throw new OrderError(
            `注册 "${name}" 会破坏拓扑序与插入序的等价性（字段 "${w}" 已被 "${reader}" 读取），拒绝注册`,
          )
        }
      }
    }
  }

  // ---- 执行 ----

  applyInput(patch: Record<string, unknown>): RunStats {
    const changed = this.applyPatch(patch)
    if (!this.hasWork(changed)) return this.lastStats
    const state = this.beginRun(++this.version, changed, false)
    while (!this.runSlice(state, Number.POSITIVE_INFINITY)) {
      // 同步执行到底
    }
    return this.commitRun(state)
  }

  async applyInputChunked(patch: Record<string, unknown>, budgetMs = 24): Promise<RunStats> {
    const changed = this.applyPatch(patch)
    if (!this.hasWork(changed)) return this.lastStats
    const state = this.beginRun(++this.version, changed, false)
    while (!this.runSlice(state, budgetMs)) await yieldToMain()
    return this.commitRun(state)
  }

  /** 优化前基线：无视 dirty，全量执行所有函数（语义等价参照物） */
  runFull(patch: Record<string, unknown> = {}): RunStats {
    const changed = this.applyPatch(patch)
    const state = this.beginRun(++this.version, changed, true)
    while (!this.runSlice(state, Number.POSITIVE_INFINITY)) {
      // 同步执行到底
    }
    return this.commitRun(state)
  }

  /** 幂等初始化：StrictMode 双调用 mount effect 时第二次直接命中，不重复执行 */
  ensureComputed(): Promise<RunStats> {
    if (!this.fullInvalidation && this.pendingFns.size === 0 && this.pendingFields.size === 0) {
      return Promise.resolve(this.lastStats)
    }
    if (this.inFlight) return this.inFlight
    this.inFlight = this.applyInputChunked({}).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private hasWork(changed: Set<string>): boolean {
    return this.fullInvalidation || changed.size > 0 || this.pendingFns.size > 0
  }

  private applyPatch(patch: Record<string, unknown>): Set<string> {
    const changed = new Set<string>()
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.is(this.ctx[key], value)) {
        this.ctx[key] = value
        changed.add(key)
      }
    }
    for (const field of this.pendingFields) changed.add(field)
    this.pendingFields.clear()
    return changed
  }

  private beginRun(version: number, changed: Set<string>, forceAll: boolean): RunState {
    const forced = new Set<string>()
    for (const name of this.pendingFns) forced.add(name)
    this.pendingFns.clear()
    const now = performance.now()
    return {
      version,
      forceAll,
      changed,
      forced,
      overlay: new Map(),
      cursor: this.entries.entries(),
      stats: { version, executed: 0, skipped: 0, durationMs: 0, aborted: false, implicitDepsFound: 0 },
      startedAt: now,
      chunkStart: now,
    }
  }

  /**
   * 单趟顺序扫描 = 拓扑序执行：注册表保证所有依赖边从先注册者指向后注册者，
   * 因此 Map 插入序本身就是合法拓扑序，顺序敏感语义与全量执行严格等价。
   * 值级裁剪：只有输出值真正变化（Object.is）才继续向下游传播。
   */
  private runSlice(state: RunState, budgetMs: number): boolean {
    for (;;) {
      if (state.version !== this.version) {
        state.stats.aborted = true
        return true
      }
      const next = state.cursor.next()
      if (next.done) return true
      const [name, entry] = next.value
      if (!this.isDirty(name, entry, state)) {
        state.stats.skipped++
        continue
      }
      this.executeOne(name, entry, state)
      state.stats.executed++
      if (performance.now() - state.chunkStart >= budgetMs) {
        state.chunkStart = performance.now()
        return false
      }
    }
  }

  private isDirty(name: string, entry: InternalEntry, state: RunState): boolean {
    if (state.forceAll || this.fullInvalidation || entry.alwaysDirty || state.forced.has(name)) return true
    for (const field of entry.allReads) {
      if (state.changed.has(field)) return true
    }
    return false
  }

  private executeOne(name: string, entry: InternalEntry, state: RunState): void {
    const actualReads = this.proxyTracking ? new Set<string>() : null
    const actualWrites = this.proxyTracking ? new Set<string>() : null
    const scope = this.makeScope(state.overlay, actualReads, actualWrites)
    entry.fn(scope)
    if (actualReads && actualWrites) {
      this.reconcileImplicit(name, entry, actualReads, actualWrites, state)
    }
    for (const field of entry.allWrites) {
      const value = state.overlay.has(field) ? state.overlay.get(field) : this.ctx[field]
      if (!Object.is(value, this.ctx[field])) state.changed.add(field)
    }
  }

  private makeScope(
    overlay: Map<string, unknown>,
    reads: Set<string> | null,
    writes: Set<string> | null,
  ): Ctx {
    const ctx = this.ctx
    return new Proxy(ctx, {
      get(target, prop) {
        if (typeof prop !== 'string') return Reflect.get(target, prop)
        reads?.add(prop)
        return overlay.has(prop) ? overlay.get(prop) : Reflect.get(target, prop)
      },
      set(target, prop, value) {
        if (typeof prop !== 'string') return Reflect.set(target, prop, value)
        writes?.add(prop)
        overlay.set(prop, value)
        return true
      },
    })
  }

  /**
   * Proxy 兜底：把执行期实际读到/写到但未声明的字段补成动态依赖边。
   * 若隐式依赖的写入者排在该函数之后（拓扑序无法与插入序等价），
   * 则降级为 alwaysDirty——每轮必执行，用性能换正确性。
   */
  private reconcileImplicit(
    name: string,
    entry: InternalEntry,
    actualReads: Set<string>,
    actualWrites: Set<string>,
    state: RunState,
  ): void {
    for (const field of actualReads) {
      if (entry.allReads.has(field)) continue
      entry.dynamicReads.add(field)
      entry.allReads.add(field)
      addToMulti(this.readers, field, name)
      state.stats.implicitDepsFound++
      this.onImplicitDep?.(name, field)
      const owner = this.writers.get(field)
      if (owner && owner !== name && !this.isBefore(owner, name)) {
        entry.alwaysDirty = true
      }
    }
    for (const field of actualWrites) {
      if (entry.allWrites.has(field)) continue
      const owner = this.writers.get(field)
      if (owner && owner !== name) {
        entry.alwaysDirty = true // 写字段归属冲突，无法安全追踪
        continue
      }
      entry.dynamicWrites.add(field)
      entry.allWrites.add(field)
      this.writers.set(field, name)
      state.stats.implicitDepsFound++
      this.onImplicitDep?.(name, field)
    }
  }

  private isBefore(a: string, b: string): boolean {
    for (const name of this.entries.keys()) {
      if (name === a) return true
      if (name === b) return false
    }
    return false
  }

  private commitRun(state: RunState): RunStats {
    state.stats.durationMs = performance.now() - state.startedAt
    if (state.stats.aborted || state.version !== this.version) {
      // 过期批次：丢弃 overlay，不触碰 ctx，不通知订阅者
      state.stats.aborted = true
      return state.stats
    }
    for (const [key, value] of state.overlay) this.ctx[key] = value
    this.committedVersion = state.version
    this.fullInvalidation = false
    this.lastStats = state.stats
    this.emit()
    return state.stats
  }
}
