import type { Ctx, RecomputeResult } from './types.ts'
import type { IncrementalEngine } from './engine.ts'

export interface BatchStats {
  version: number
  executedCount: number
  durationMs: number
}

/**
 * 版本化批次调度器：输入连续触发时合并为最新批次，过期批次直接丢弃，
 * 旧批次结果绝不允许覆盖新结果。
 */
export class RecomputeScheduler {
  private engine: IncrementalEngine
  private commit: (result: RecomputeResult) => void
  private latestVersion = 0
  private committedVersion = 0
  private pending: Ctx = {}
  private scheduled = false
  /** 被丢弃的过期批次数（监控用） */
  discardedBatches = 0
  lastStats: BatchStats | null = null

  constructor(engine: IncrementalEngine, commit: (result: RecomputeResult) => void) {
    this.engine = engine
    this.commit = commit
  }

  get committed(): number {
    return this.committedVersion
  }

  pushInput(patch: Ctx): void {
    Object.assign(this.pending, patch)
    this.latestVersion++
    if (!this.scheduled) {
      this.scheduled = true
      // 微任务合批：同一轮事件循环里的连续按键只执行最后一次
      queueMicrotask(() => this.flush())
    }
  }

  flush(): void {
    this.scheduled = false
    const version = this.latestVersion
    if (version === this.committedVersion) return
    const patch = this.pending
    this.pending = {}

    const changed = this.engine.applyInputs(patch)
    const result = this.engine.recompute(changed)

    if (version !== this.latestVersion) {
      // 执行期间又有新输入（如业务函数内重入 pushInput）：本批结果已过期，丢弃不提交
      this.discardedBatches++
      return
    }
    this.committedVersion = version
    this.lastStats = {
      version,
      executedCount: result.executed.length,
      durationMs: result.durationMs,
    }
    if (result.executed.length > 0) this.commit(result)
  }
}
