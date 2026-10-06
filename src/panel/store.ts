import { BatchError, IncrementalEngine } from './engine.ts'
import { INPUT_FIELD } from './registry.ts'
import type { BatchFailure } from './engine.ts'
import type { Ctx, Registry, RunStats } from './types.ts'

const collectAggFields = (registry: Registry): string[] => {
  const fields: string[] = []
  for (const [name, entry] of registry) {
    if (name.startsWith('agg.')) fields.push(...entry.writes)
  }
  return fields
}

/**
 * 面板状态store：框架无关，React 侧通过 useSyncExternalStore 订阅。
 * 汇总区快照做浅比较缓存——40 个 agg 输出任一未变就返回同一引用，
 * 保证"未变化的输入不得触发汇总区 render"。
 */
export class PanelStore {
  readonly engine: IncrementalEngine
  private readonly listeners = new Set<() => void>()
  private readonly errorListeners = new Set<(failure: BatchFailure) => void>()
  private statsSnap: RunStats
  private aggSnap: readonly unknown[] = []
  private aggFields: string[]

  constructor(registry: Registry, ctx: Ctx = {}, onError?: (failure: BatchFailure) => void) {
    if (!(INPUT_FIELD in ctx)) ctx[INPUT_FIELD] = ''
    this.engine = new IncrementalEngine(registry, ctx, {
      onError: (failure) => {
        onError?.(failure)
        for (const listener of [...this.errorListeners]) listener(failure)
      },
    })
    this.aggFields = collectAggFields(registry)
    this.statsSnap = this.engine.getStats()
    this.engine.subscribe(() => this.emit())
  }

  /** HMR：整体替换注册表（缓存与 DAG 全失效），并刷新订阅 */
  replaceRegistry(registry: Registry): void {
    this.engine.replaceRegistry(registry)
    this.aggFields = collectAggFields(registry)
    this.aggSnap = []
    this.emit()
  }

  /** 撤销最近一次输入批次；没有历史时返回 false（不报错、不通知） */
  undo(): boolean {
    if (!this.engine.canUndo()) return false
    this.engine.undoLastBatch()
    return true
  }

  get undoDepth(): number {
    return this.engine.undoDepth
  }

  canUndo(): boolean {
    return this.engine.canUndo()
  }

  getLastError(): BatchFailure | null {
    return this.engine.getLastError()
  }

  /** 错误通道订阅：批次回滚时触发，与普通状态提交通知互相独立 */
  subscribeErrors(cb: (failure: BatchFailure) => void): () => void {
    this.errorListeners.add(cb)
    return () => {
      this.errorListeners.delete(cb)
    }
  }

  private emit(): void {
    this.statsSnap = this.engine.getStats()
    const next = this.aggFields.map((field) => this.engine.ctx[field])
    const same =
      next.length === this.aggSnap.length &&
      next.every((value, i) => Object.is(value, this.aggSnap[i]))
    if (!same) this.aggSnap = Object.freeze(next)
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

  /** 事件层驱动重算（绝不在 render 内执行） */
  setInput(text: string): void {
    try {
      this.engine.applyInput({ [INPUT_FIELD]: text })
    } catch (err) {
      // 引擎已整体回滚并经 onError 通道上报；事件层不吞错为静默失败
      if (!(err instanceof BatchError)) throw err
    }
  }

  /** 幂等初始化：StrictMode 双调用 mount effect 安全 */
  initialize(): Promise<RunStats> {
    return this.engine.ensureComputed()
  }
}
