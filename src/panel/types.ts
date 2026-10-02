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
}
