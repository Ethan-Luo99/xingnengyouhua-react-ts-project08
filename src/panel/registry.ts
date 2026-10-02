import { busyWait } from './busyWait.ts'
import type { Ctx, FnEntry } from './types.ts'

/**
 * 业务函数注册表：560 个叶子计算 + 40 个汇总函数 = 600 个。
 *
 * 依赖链（4 层，后者读前者对 ctx 的写入）：
 *   input.k*  ->  leaf0_i   （200 个，各读 1 个输入字段）
 *   leaf0_*   ->  leaf1_i   （200 个，各读 2 个 leaf0 输出）
 *   leaf1_*   ->  leaf2_i   （160 个，各读 2 个 leaf1 输出）
 *   leaf2_*   ->  summary_i （40 个，各读 4 个 leaf2 输出 + 1 个 leaf1 输出）
 *
 * 每个函数同步 busy-wait 约 0.4ms，全量执行 600 × 0.4ms ≈ 240ms > 200ms。
 * 单次按键只改 input.k0，受影响子图 = 10 leaf0 + 20 leaf1 + 16 leaf2 + 16 summary = 62 个。
 */
export const INPUT_COUNT = 20
export const INPUT_KEYS = Array.from({ length: INPUT_COUNT }, (_, i) => `input.k${i}`)
export const KEYSTROKE_INPUT = 'input.k0'
export const LEAF0_COUNT = 200
export const LEAF1_COUNT = 200
export const LEAF2_COUNT = 160
export const SUMMARY_COUNT = 40
export const TOTAL_COUNT = LEAF0_COUNT + LEAF1_COUNT + LEAF2_COUNT + SUMMARY_COUNT
export const SUMMARY_NAMES = Array.from(
  { length: SUMMARY_COUNT },
  (_, i) => `summary_${String(i).padStart(2, '0')}`,
)
export const INITIAL_INPUTS: Ctx = Object.fromEntries(
  INPUT_KEYS.map((key, i) => [key, `seed-${i}`]),
)

/** 确定性的值混合函数（FNV-1a 变体），保证等价性快照可比对 */
function mix(values: readonly unknown[], salt: number): number {
  let hash = 2166136261 ^ salt
  for (const value of values) {
    const str = String(value)
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
  }
  return hash >>> 0
}

export interface BuildOptions {
  /** 每个函数的同步耗时（ms），测试可传 0 加速 */
  costMs?: number
}

export function buildRegistry(options: BuildOptions = {}): FnEntry[] {
  const costMs = options.costMs ?? 0.4
  const entries: FnEntry[] = []
  let salt = 0

  const make = (name: string, reads: readonly string[]): FnEntry => {
    const mySalt = ++salt
    const writeField = `out.${name}`
    return {
      name,
      meta: { reads, writes: [writeField] },
      fn: (ctx: Ctx) => {
        busyWait(costMs)
        const value = mix(reads.map((r) => ctx[r]), mySalt)
        ctx[writeField] = value
        return value
      },
    }
  }

  for (let i = 0; i < LEAF0_COUNT; i++) {
    entries.push(make(`leaf0_${i}`, [INPUT_KEYS[i % INPUT_COUNT]]))
  }
  for (let i = 0; i < LEAF1_COUNT; i++) {
    entries.push(make(`leaf1_${i}`, [`out.leaf0_${i}`, `out.leaf0_${(i + 1) % LEAF0_COUNT}`]))
  }
  for (let i = 0; i < LEAF2_COUNT; i++) {
    entries.push(make(`leaf2_${i}`, [`out.leaf1_${i}`, `out.leaf1_${(i + 40) % LEAF1_COUNT}`]))
  }
  for (let i = 0; i < SUMMARY_COUNT; i++) {
    entries.push(
      make(SUMMARY_NAMES[i], [
        `out.leaf2_${i * 4}`,
        `out.leaf2_${i * 4 + 1}`,
        `out.leaf2_${i * 4 + 2}`,
        `out.leaf2_${i * 4 + 3}`,
        `out.leaf1_${i}`,
      ]),
    )
  }
  return entries
}
