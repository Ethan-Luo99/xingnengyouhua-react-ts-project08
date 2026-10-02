import type { RecomputeResult } from './types.ts'

/**
 * 输出 store：汇总区按函数名精准订阅，选中值全部 Object.is 相等时
 * getSelection 返回缓存引用，useSyncExternalStore 因此不触发 re-render。
 */
export class OutputStore {
  private outputs: Record<string, unknown> = {}
  private stats: { executedCount: number; durationMs: number } | null = null
  private statsRef: { executedCount: number; durationMs: number } | null = null
  private listeners = new Set<() => void>()
  private selectionCache = new Map<string, readonly unknown[]>()

  subscribe = (callback: () => void): (() => void) => {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  commit(result: RecomputeResult): void {
    this.outputs = result.outputs
    this.stats = { executedCount: result.executed.length, durationMs: result.durationMs }
    this.statsRef = null
    for (const listener of this.listeners) listener()
  }

  /** 按函数名取输出；未变化时返回与上次相同的数组引用 */
  getSelection(names: readonly string[]): readonly unknown[] {
    const cacheKey = names.join('')
    const cached = this.selectionCache.get(cacheKey)
    const values = names.map((name) => this.outputs[name])
    if (
      cached &&
      cached.length === values.length &&
      cached.every((v, i) => Object.is(v, values[i]))
    ) {
      return cached
    }
    this.selectionCache.set(cacheKey, values)
    return values
  }

  getStats(): { executedCount: number; durationMs: number } | null {
    if (this.stats === null) return null
    if (this.statsRef === null) this.statsRef = this.stats
    return this.statsRef
  }
}
