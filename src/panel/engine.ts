import type { BatchFailureInfo, Ctx, FnEntry, Registry, RunStats } from './types.ts'

export class CycleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CycleError'
  }
}

export class UndoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UndoError'
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
  /**
   * 错误明确通道：批次内任一业务函数抛错时回调。
   * 批次整体回滚（ctx 保持上一提交点），该回调只负责上报，不改变回滚行为。
   */
  onBatchFailure?: (info: BatchFailureInfo) => void
  /** undo 历史最大层数（默认 50，至少支持连续 5 层） */
  maxUndoDepth?: number
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
  failed: boolean
  failedFn: string | null
  reverted: boolean
  errorValue: unknown
  /** 本批次启动时从 pendingFns/pendingFields 抽干的项：失败时需要还回去 */
  drainedFns: Set<string>
  drainedFields: Set<string>
  /** undo 重放对应的历史记录：undo 失败时重新入栈，保留撤销点 */
  undoLog: BatchLog | null
}

/**
 * 单次提交的字段级历史记录（undo 的唯一持久状态）。
 *
 * 空间复杂度 O(该批次实际改变的字段数 + 当轮首次执行的动态注册函数数)，
 * 与 ctx 总大小无关——不做任何全量深拷贝：
 * - `changes` 只保存提交时 overlay 中相对 ctx 真正发生变化（!Object.is）
 *   的字段及其【提交前旧值】；未写或写了但值未变的字段一律不记。
 * - 恢复时把旧值以 overlay 方式暂存，跑同一套 dirty 传播，只重算
 *   "读这些字段"的受影响子图，绝不全量重跑 600 个函数。
 * - `firstForced` 只对当轮首次执行的动态注册函数打标：它的首执行
 *   不依赖输入变化，undo 重放时必须同样强制一次，才能与全量语义逐字段一致。
 */
interface BatchLog {
  version: number
  changes: Map<string, unknown>
  firstForced: Set<string>
  /**
   * 该批次是否发生在冷启动整体失效点上（此前无任何已计算提交点）。
   * 撤销它时不存在可增量命中的"上一派生状态"，只能对恢复后的输入
   * 整体重算一次；真实面板由 ensureComputed 建立基线，用户批次永不命中此分支。
   */
  fromFull: boolean
}

/** overlay 内标记"ctx 中不存在该键"：回滚/恢复时删除而不是写入 undefined */
const ABSENT = Symbol('absent')

const yieldToMain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** 相等性：ABSENT 哨兵只与自身相等（Object.is 会把 Symbol 当普通值，不能用于"不存在"判定） */
const isSameValue = (a: unknown, b: unknown): boolean =>
  a === ABSENT || b === ABSENT ? a === b : Object.is(a, b)

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
  private readonly onBatchFailure?: (info: BatchFailureInfo) => void
  private readonly maxUndoDepth: number
  /** 已提交批次的字段级历史栈，栈顶 = 最近一次提交 */
  private readonly undoStack: BatchLog[] = []
  private lastStats: RunStats = {
    version: 0,
    executed: 0,
    skipped: 0,
    durationMs: 0,
    aborted: false,
    implicitDepsFound: 0,
    failed: false,
    reverted: false,
  }
  private readonly listeners = new Set<() => void>()
  private inFlight: Promise<RunStats> | null = null

  constructor(registry: Registry, ctx: Ctx = {}, options: EngineOptions = {}) {
    this.ctx = ctx
    this.proxyTracking = options.trackReadsWithProxy ?? true
    this.onImplicitDep = options.onImplicitDep
    this.onBatchFailure = options.onBatchFailure
    this.maxUndoDepth = options.maxUndoDepth ?? 50
    this.loadRegistry(registry)
  }

  get size(): number {
    return this.entries.size
  }

  get committed(): number {
    return this.committedVersion
  }

  /** 可撤销的已提交批次数 */
  get undoDepth(): number {
    return this.undoStack.length
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
    // 函数实现已整体变更：旧历史记录里的字段旧值对新实现不再有语义，
    // 全部作废，防止 undo 跨实现版本恢复出混合语义的 ctx。
    this.undoStack.length = 0
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
    const { changed, overlay, drainedFields } = this.stagePatch(patch)
    if (!this.hasWork(changed)) return this.lastStats
    const state = this.beginRun(++this.version, changed, false, overlay, drainedFields)
    while (!this.runSlice(state, Number.POSITIVE_INFINITY)) {
      // 同步执行到底
    }
    return this.commitRun(state)
  }

  async applyInputChunked(patch: Record<string, unknown>, budgetMs = 24): Promise<RunStats> {
    const { changed, overlay, drainedFields } = this.stagePatch(patch)
    if (!this.hasWork(changed)) return this.lastStats
    const state = this.beginRun(++this.version, changed, false, overlay, drainedFields)
    while (!this.runSlice(state, budgetMs)) await yieldToMain()
    return this.commitRun(state)
  }

  /** 优化前基线：无视 dirty，全量执行所有函数（语义等价参照物） */
  runFull(patch: Record<string, unknown> = {}): RunStats {
    const { changed, overlay, drainedFields } = this.stagePatch(patch)
    const state = this.beginRun(++this.version, changed, true, overlay, drainedFields)
    while (!this.runSlice(state, Number.POSITIVE_INFINITY)) {
      // 同步执行到底
    }
    return this.commitRun(state)
  }

  /**
   * 撤销最近一次已提交批次：
   * 1. 取出栈顶 BatchLog（字段旧值 + 当轮首执行的动态函数）；
   * 2. 旧值以 overlay 暂存（不触碰 ctx），仅把这些字段标记为 changed；
   * 3. 走同一趟顺序扫描 + dirty 传播，只重算受影响子图；
   * 4. 成功则提交（恢复点成为新的已提交状态，不再产生 undo 记录）。
   */
  undoLastBatch(): RunStats {
    const state = this.beginUndo()
    while (!this.runSlice(state, Number.POSITIVE_INFINITY)) {
      // 同步执行到底
    }
    return this.commitRun(state)
  }

  async undoLastBatchChunked(budgetMs = 24): Promise<RunStats> {
    const state = this.beginUndo()
    while (!this.runSlice(state, budgetMs)) await yieldToMain()
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

  /**
   * 输入补丁只暂存进 overlay（批次隔离的关键）：批次失败/被新版本丢弃时，
   * ctx 从未被触碰，物理上不存在"半提交"，无需反向修补输入。
   */
  private stagePatch(patch: Record<string, unknown>): { changed: Set<string>; overlay: Map<string, unknown>; drainedFields: Set<string> } {
    const changed = new Set<string>()
    const overlay = new Map<string, unknown>()
    for (const [key, value] of Object.entries(patch)) {
      const current = key in this.ctx ? this.ctx[key] : ABSENT
      if (!isSameValue(current, value)) {
        overlay.set(key, value)
        changed.add(key)
      }
    }
    const drainedFields = new Set(this.pendingFields)
    for (const field of drainedFields) changed.add(field)
    this.pendingFields.clear()
    return { changed, overlay, drainedFields }
  }

  private beginUndo(): RunState {
    const log = this.undoStack.pop()
    if (!log) {
      throw new UndoError('没有可撤销的已提交批次')
    }
    // 把字段恢复值暂存进 overlay；changed 只含真正变化的字段 =>
    // dirty 传播精确命中"该批次写入字段的下游子图"，非 600 全量。
    const changed = new Set<string>()
    const overlay = new Map<string, unknown>()
    for (const [field, oldValue] of log.changes) {
      const current = field in this.ctx ? this.ctx[field] : ABSENT
      if (!isSameValue(current, oldValue)) {
        overlay.set(field, oldValue)
        changed.add(field)
      }
    }
    // 动态注册函数是结构性变化（不属于输入批次，undo 不注销）；
    // 它在原批次首执行时与输入无关，恢复重放需同样强制一次，
    // 保证恢复后 ctx 与"只经历恢复后输入序列"的全量结果逐字段一致。
    const forced = new Set<string>()
    for (const name of log.firstForced) {
      if (this.entries.has(name)) forced.add(name)
    }
    const drainedFns = new Set(this.pendingFns)
    for (const name of drainedFns) {
      forced.add(name)
    }
    this.pendingFns.clear()
    const drainedFields = new Set(this.pendingFields)
    for (const field of drainedFields) changed.add(field)
    this.pendingFields.clear()
    const now = performance.now()
    return {
      version: ++this.version,
      forceAll: log.fromFull,
      changed,
      forced,
      overlay,
      cursor: this.entries.entries(),
      stats: {
        version: this.version,
        executed: 0,
        skipped: 0,
        durationMs: 0,
        aborted: false,
        implicitDepsFound: 0,
        failed: false,
        reverted: true,
      },
      startedAt: now,
      chunkStart: now,
      failed: false,
      failedFn: null,
      reverted: true,
      errorValue: undefined,
      drainedFns,
      drainedFields,
      undoLog: log,
    }
  }

  private beginRun(
    version: number,
    changed: Set<string>,
    forceAll: boolean,
    overlay: Map<string, unknown>,
    drainedFields: Set<string>,
  ): RunState {
    const forced = new Set<string>()
    const drainedFns = new Set(this.pendingFns)
    for (const name of drainedFns) forced.add(name)
    this.pendingFns.clear()
    const now = performance.now()
    return {
      version,
      forceAll,
      changed,
      forced,
      overlay,
      cursor: this.entries.entries(),
      stats: { version, executed: 0, skipped: 0, durationMs: 0, aborted: false, implicitDepsFound: 0, failed: false, reverted: false },
      startedAt: now,
      chunkStart: now,
      failed: false,
      failedFn: null,
      reverted: false,
      errorValue: undefined,
      drainedFns,
      drainedFields,
      undoLog: null,
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
      try {
        this.executeOne(name, entry, state)
      } catch (error) {
        // 业务函数抛错：立即停止本批次扫描，overlay 整体丢弃。
        state.failed = true
        state.failedFn = name
        state.stats.failed = true
        state.errorValue = error
        return true
      }
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
      const value = state.overlay.has(field) ? state.overlay.get(field) : this.readCommitted(field)
      if (!Object.is(value, this.readCommitted(field))) state.changed.add(field)
    }
  }

  private readCommitted(field: string): unknown {
    return field in this.ctx ? this.ctx[field] : undefined
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
        if (overlay.has(prop)) {
          const value = overlay.get(prop)
          return value === ABSENT ? undefined : value
        }
        return Reflect.get(target, prop)
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

    // 失败批次：overlay 物理丢弃，ctx 一字段未动，停在上一提交点；
    // 版本号已 +1 使可能在飞的其他批次过期。错误经明确通道上报。
    if (state.failed) {
      // 归还启动时抽干的待处理项：下一次成功输入必须仍能强制首执行
      // 动态注册函数、仍能把注销字段的下游按全量语义重算。
      for (const name of state.drainedFns) {
        if (this.entries.has(name)) this.pendingFns.add(name)
      }
      for (const field of state.drainedFields) this.pendingFields.add(field)
      // undo 自身失败：恢复点保留，调用方可修正后重试 undo。
      if (state.undoLog) this.undoStack.push(state.undoLog)
      this.lastStats = state.stats
      this.onBatchFailure?.({ version: state.version, fnName: state.failedFn ?? '', error: state.errorValue })
      return state.stats
    }

    // 过期批次：丢弃 overlay，不触碰 ctx，不通知订阅者。
    if (state.stats.aborted || state.version !== this.version) {
      state.stats.aborted = true
      // undo 被更新版本打断：按引擎既有版本语义，旧批次（含其撤销意图）作废，
      // 该撤销点在 beginUndo 时已出栈并在此消费——栈与已提交状态序列保持一致：
      // 撤销一层 + 新提交一层，深度不变；再 undo 即恢复到新输入的前一状态。
      this.lastStats = state.stats
      return state.stats
    }

    if (state.reverted) {
      // undo 提交：恢复字段 + 受影响子图重算结果一起落盘，不产生新历史记录。
      for (const [key, value] of state.overlay) {
        if (value === ABSENT) delete this.ctx[key]
        else this.ctx[key] = value
      }
      this.committedVersion = state.version
      this.fullInvalidation = false
      this.lastStats = state.stats
      this.emit()
      return state.stats
    }

    // 正常提交：构建字段级历史（只记真正变化字段的提交前旧值）后再落盘。
    const changes = new Map<string, unknown>()
    for (const [key, value] of state.overlay) {
      const before = key in this.ctx ? this.ctx[key] : ABSENT
      if (!isSameValue(before, value)) changes.set(key, before)
      if (value === ABSENT) delete this.ctx[key]
      else this.ctx[key] = value
    }
    // 当轮首执行的动态注册函数：下一次 undo 恢复时需要同等强制一次。
    const firstForced = new Set(state.forced)
    const fromFull = this.fullInvalidation

    this.committedVersion = state.version
    this.fullInvalidation = false
    if (changes.size > 0 || firstForced.size > 0) {
      this.undoStack.push({ version: state.version, changes, firstForced, fromFull })
      if (this.undoStack.length > this.maxUndoDepth) this.undoStack.shift()
    }
    this.lastStats = state.stats
    this.emit()
    return state.stats
  }
}
