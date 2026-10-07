import { IncrementalEngine, RedoError, UndoError } from './engine.ts'
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
 * undo/redo 一致性：快照引用栈 + 游标（游标恒等于 engine.undoDepth），
 * 每个历史层级保存该提交点的汇总快照【引用】，撤销/重做只是移动游标、
 * 直接还原为当时的同一引用（值级恢复由引擎字段级日志保证），
 * 因此 a → b → undo → redo 后 getAggSnapshot() === b 提交点的快照引用，
 * useSyncExternalStore/memo 行为与历史状态严格一致。
 */
export class PanelStore {
  readonly engine: IncrementalEngine
  private readonly listeners = new Set<() => void>()
  private statsSnap: RunStats
  private aggSnap: readonly unknown[] = Object.freeze([])
  private aggFields: string[]
  /** 快照引用栈：长度恒等于 engine.undoDepth + engine.redoDepth + 1 */
  private snapStack: Array<readonly unknown[]> = [this.aggSnap]
  /** 当前提交点在 snapStack 中的下标（恒等于 engine.undoDepth） */
  private cursor = 0
  /** 已对齐的引擎 undo 栈底部截断次数 */
  private shiftsSeen = 0

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
    this.cursor = 0
    this.shiftsSeen = this.engine.undoShiftCount
    this.emit()
  }

  private emit(): void {
    this.statsSnap = this.engine.getStats()

    // 引擎 undo 栈容量截断最老层时，快照栈同步从底部丢弃，保持逐层对齐。
    const shifts = this.engine.undoShiftCount - this.shiftsSeen
    if (shifts > 0) {
      this.snapStack.splice(0, shifts)
      this.cursor -= shifts
      this.shiftsSeen = this.engine.undoShiftCount
    }

    if (this.statsSnap.reverted) {
      // undo/redo 提交：游标对齐引擎 undo 栈深度，直接还原该提交点的快照引用。
      this.cursor = this.engine.undoDepth
      this.aggSnap = this.snapStack[this.cursor]
    } else {
      const next = this.aggFields.map((field) => this.engine.ctx[field])
      const same =
        next.length === this.aggSnap.length &&
        next.every((value, i) => Object.is(value, this.aggSnap[i]))
      if (!same) this.aggSnap = Object.freeze(next)

      // 新输入成功提交：重做线作废，截断游标之后的所有快照。
      this.snapStack.length = this.cursor + 1
      if (this.engine.undoDepth > this.cursor) {
        this.snapStack.push(this.aggSnap)
        this.cursor = this.engine.undoDepth
      } else {
        // 引擎未记账的提交（如注销函数但输出值未变）：当前层快照就地更新
        this.snapStack[this.cursor] = this.aggSnap
      }
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

  /** 重做最近一次被撤销的批次（只重算受影响子图）；重做线为空时抛 RedoError */
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

export { RedoError, UndoError }
