import { IncrementalEngine } from './engine.ts'
import { INPUT_FIELD } from './registry.ts'
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
  private statsSnap: RunStats
  private aggSnap: readonly unknown[] = []
  private aggFields: string[]

  constructor(registry: Registry, ctx: Ctx = {}) {
    if (!(INPUT_FIELD in ctx)) ctx[INPUT_FIELD] = ''
    this.engine = new IncrementalEngine(registry, ctx)
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
    this.engine.applyInput({ [INPUT_FIELD]: text })
  }

  /** 幂等初始化：StrictMode 双调用 mount effect 安全 */
  initialize(): Promise<RunStats> {
    return this.engine.ensureComputed()
  }
}
