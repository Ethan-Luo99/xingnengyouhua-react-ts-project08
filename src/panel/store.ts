import { IncrementalEngine, UndoError } from './engine.ts'
import { INPUT_FIELD } from './registry.ts'
import type { BatchFailureInfo, Ctx, Registry, RunStats } from './types.ts'

const collectAggFields = (registry: Registry): string[] => {
  const fields: string[] = []
  for (const [name, entry] of registry) {
    if (name.startsWith('agg.')) fields.push(...entry.writes)
  }
  return fields
}

export interface PanelStoreOptions {
  /** 批次失败的明确上报通道（回滚行为不依赖该回调是否提供） */
  onBatchFailure?: (info: BatchFailureInfo) => void
}

/**
 * 面板状态store：框架无关，React 侧通过 useSyncExternalStore 订阅。
 * 汇总区快照做浅比较缓存——40 个 agg 输出任一未变就返回同一引用，
 * 保证"未变化的输入不得触发汇总区 render"。
 *
 * undo/redo 一致性：每个 undo 层级保存该提交点的汇总快照【引用】，
 * 撤销时直接还原为当时的同一引用（值级恢复由引擎字段级日志保证），
 * 因此 a → b → undo 后 getAggSnapshot() === a 提交点的快照引用；
 * redo 引用栈与引擎 redo 栈同步移动，undo → redo 后同样还原为
 * 被撤销提交点的同一数组引用，useSyncExternalStore/memo 行为历史一致。
 */
export class PanelStore {
  readonly engine: IncrementalEngine
  private readonly listeners = new Set<() => void>()
  private statsSnap: RunStats
  private aggSnap: readonly unknown[] = Object.freeze([])
  private aggFields: string[]
  /** 快照引用栈：长度恒等于 engine.undoDepth + 1，栈顶 = 当前提交点 */
  private snapStack: Array<readonly unknown[]> = [this.aggSnap]
  /** redo 快照引用栈：与引擎 redo 栈同步，栈顶 = 最近一次 undo 掉的提交点 */
  private redoSnapStack: Array<readonly unknown[]> = []
  private undoDepthSeen = 0

  constructor(registry: Registry, ctx: Ctx = {}, options: PanelStoreOptions = {}) {
    if (!(INPUT_FIELD in ctx)) ctx[INPUT_FIELD] = ''
    this.engine = new IncrementalEngine(registry, ctx, { onBatchFailure: options.onBatchFailure })
    this.aggFields = collectAggFields(registry)
    this.statsSnap = this.engine.getStats()
    this.engine.subscribe(() => this.emit())
  }

  /** HMR：整体替换注册表（缓存与 DAG、undo 历史全失效），并刷新订阅 */
  replaceRegistry(registry: Registry): void {
    this.engine.replaceRegistry(registry)
    this.aggFields = collectAggFields(registry)
    this.aggSnap = Object.freeze([])
    this.snapStack = [this.aggSnap]
    this.redoSnapStack = []
    this.undoDepthSeen = 0
    this.emit()
  }

  private emit(): void {
    this.statsSnap = this.engine.getStats()

    if (this.statsSnap.reverted) {
      // undo 提交：被撤销层的快照引用移入 redo 引用栈，还原上一提交点引用。
      const popped = this.snapStack.pop()
      if (popped) this.redoSnapStack.push(popped)
      this.aggSnap = this.snapStack[this.snapStack.length - 1]
      this.undoDepthSeen = this.engine.undoDepth
    } else if (this.statsSnap.redone) {
      // redo 提交：redo 引用栈顶弹回 undo 引用栈，恢复被撤销提交点的同一引用。
      const popped = this.redoSnapStack.pop()
      if (popped) this.snapStack.push(popped)
      this.aggSnap = this.snapStack[this.snapStack.length - 1]
      this.undoDepthSeen = this.engine.undoDepth
    } else {
      // 新输入成功提交：重做线被切断，redo 引用栈同步清空。
      this.redoSnapStack.length = 0
      const next = this.aggFields.map((field) => this.engine.ctx[field])
      const same =
        next.length === this.aggSnap.length &&
        next.every((value, i) => Object.is(value, this.aggSnap[i]))
      if (!same) this.aggSnap = Object.freeze(next)

      const depth = this.engine.undoDepth
      if (depth > this.undoDepthSeen) {
        this.snapStack.push(this.aggSnap)
      } else if (depth === this.undoDepthSeen) {
        // 引擎未记账的提交（如注销函数但输出值未变）：当前层快照就地更新
        this.snapStack[this.snapStack.length - 1] = this.aggSnap
      }
      this.undoDepthSeen = depth
    }

    for (const listener of [...this.listeners]) listener()
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  getStatsSnapshot = (): RunStats => this.statsSnap

  getAggSnapshot = (): readonly unknown[] => this.aggSnap

  getUndoDepth = (): number => this.engine.undoDepth

  getRedoDepth = (): number => this.engine.redoDepth

  /** 事件层驱动重算（绝不在 render 内执行）；失败批次返回 failed 统计（ctx 已回滚） */
  setInput(text: string): RunStats {
    return this.engine.applyInput({ [INPUT_FIELD]: text })
  }

  /** 撤销最近一次已提交批次（只重算受影响子图）；无历史时抛 UndoError */
  undoLastBatch(): RunStats {
    return this.engine.undoLastBatch()
  }

  undoLastBatchChunked(budgetMs = 24): Promise<RunStats> {
    return this.engine.undoLastBatchChunked(budgetMs)
  }

  /** 重做最近一次被撤销的批次（只重算受影响子图）；无可重做项时抛 UndoError */
  redoLastUndo(): RunStats {
    return this.engine.redoLastUndo()
  }

  redoLastUndoChunked(budgetMs = 24): Promise<RunStats> {
    return this.engine.redoLastUndoChunked(budgetMs)
  }

  /** 幂等初始化：StrictMode 双调用 mount effect 安全 */
  initialize(): Promise<RunStats> {
    return this.engine.ensureComputed()
  }
}

export { UndoError }
