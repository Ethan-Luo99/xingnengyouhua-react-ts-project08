export type Ctx = Record<string, unknown>

export type BusinessFn = (ctx: Ctx) => unknown

export interface FnEntry {
  fn: BusinessFn
  reads: string[]
  writes: string[]
}

export type Registry = Map<string, FnEntry>

export interface RunStats {
  version: number
  executed: number
  skipped: number
  durationMs: number
  aborted: boolean
  implicitDepsFound: number
  /** 批次内有业务函数抛错：overlay 已整体丢弃，ctx 保持上一提交点 */
  failed: boolean
  /** 本轮为 undo 提交（受影响子图增量重算） */
  reverted: boolean
  /** 本轮为 redo 提交（受影响子图增量重算） */
  redone: boolean
}

/** 批次失败上报：错误通道只透传，绝不进入半提交状态 */
export interface BatchFailureInfo {
  version: number
  fnName: string
  error: unknown
}
