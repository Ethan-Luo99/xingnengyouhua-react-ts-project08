export type Ctx = Record<string, unknown>

export type BusinessFn = (ctx: Ctx) => unknown

export interface FnMeta {
  /** 声明读取的 ctx 字段；undefined 表示"未声明"，调度器按保守策略永远重算 */
  reads?: readonly string[]
  /** 声明写入的 ctx 字段（必须声明，否则无法建图） */
  writes: readonly string[]
}

export interface FnEntry {
  name: string
  fn: BusinessFn
  meta: FnMeta
}

export interface RecomputeResult {
  executed: string[]
  durationMs: number
  outputs: Record<string, unknown>
}
