import { busyWait } from './busyWait.ts'
import type { Registry } from './types.ts'

export const INPUT_FIELD = 'input.text'

export const PARSER_COUNT = 20
export const L0_COUNT = 180
export const L1_COUNT = 200
export const L2_COUNT = 160
export const AGG_COUNT = 40
export const LEAF_COUNT = PARSER_COUNT + L0_COUNT + L1_COUNT + L2_COUNT // 560
export const TOTAL_COUNT = LEAF_COUNT + AGG_COUNT // 600

// "!" 计数（p.3）的专用依赖链：leaf0[0..15] -> leaf1[0..15] -> leaf2[128..159]，
// 该链路不被任何汇总函数订阅，用于验证汇总区的精准订阅。
const CHAIN_L0 = 16
const CHAIN_L1 = 16
const CHAIN_L2 = 32
const NORMAL_L0 = L0_COUNT - CHAIN_L0 // 164
const NORMAL_L1 = L1_COUNT - CHAIN_L1 // 184
const NORMAL_L2 = L2_COUNT - CHAIN_L2 // 128

// 绑定少量叶子的解析器（量化边界型信号）
const DEDICATED_PARSERS = [0, 4, 6, 7]
const DEDICATED_GROUP_SIZE = 8
// 其余叶子分散绑定的解析器
const SPREAD_PARSERS = [1, 2, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]

const countChar = (text: string, ch: string): number => {
  let n = 0
  for (const c of text) if (c === ch) n++
  return n
}

const countWhere = (text: string, pred: (c: string) => boolean): number => {
  let n = 0
  for (const c of text) if (pred(c)) n++
  return n
}

// 解析器把原始输入量化成"结构信号"：大多数按键不会改变它们，
// 这是真实业务中"输入变了但多数派生值没变"的缩影，也是增量重算的收益来源。
const PARSERS: Array<(text: string) => number> = [
  (t) => Math.floor(t.length / 16),
  (t) => countChar(t, ' '),
  (t) => countWhere(t, (c) => c >= '0' && c <= '9'),
  (t) => countChar(t, '!'),
  (t) => countChar(t, '#'),
  (t) => countWhere(t, (c) => c >= 'A' && c <= 'Z'),
  (t) => countChar(t, '.'),
  (t) => Math.floor(countChar(t, 'a') / 8),
  (t) => countChar(t, ','),
  (t) => countChar(t, 'x'),
  (t) => countChar(t, '?'),
  (t) => Math.floor(countChar(t, 'e') / 4),
  (t) => countChar(t, '-'),
  (t) => Math.floor(countChar(t, 'o') / 4),
  (t) => countChar(t, ':'),
  (t) => countChar(t, ';'),
  (t) => countChar(t, '('),
  (t) => countChar(t, ')'),
  (t) => Math.floor(countChar(t, 't') / 4),
  (t) => countChar(t, '@'),
]

const l0ParserOf = (i: number): number => {
  const offset = i - CHAIN_L0
  const dedicatedSpan = DEDICATED_PARSERS.length * DEDICATED_GROUP_SIZE
  if (offset < dedicatedSpan) return DEDICATED_PARSERS[Math.floor(offset / DEDICATED_GROUP_SIZE)]
  return SPREAD_PARSERS[(offset - dedicatedSpan) % SPREAD_PARSERS.length]
}

export interface RegistryOptions {
  /** 每个函数的同步耗时，默认 0.4ms（600 个函数全量 > 200ms） */
  busyWaitMs?: number
  /** 实现变体号：模拟 HMR 热替换后的新实现（改变每个函数的计算结果） */
  variant?: number
}

/**
 * 生成 600 个业务函数的注册表（Map 插入序 = 执行序）：
 * - 20 个解析器：读 input.text，写 p.*（第 0 层）
 * - 180 + 200 + 160 个叶子：读上一层输出，写 l0.* / l1.* / l2.*（真实 3 层以上依赖链）
 * - 40 个汇总函数：读 l2.[0..127]，写 agg.*
 * 所有依赖边都从先注册者指向后注册者，因此"插入序"天然是一个合法拓扑序。
 */
export function buildRegistry(options: RegistryOptions = {}): Registry {
  const busy = options.busyWaitMs ?? 0.4
  const variant = options.variant ?? 1
  const registry: Registry = new Map()

  const define = (
    name: string,
    reads: string[],
    writeField: string,
    compute: (read: (field: string) => number) => number,
  ): void => {
    registry.set(name, {
      reads,
      writes: [writeField],
      fn: (ctx) => {
        const read = (field: string) => ctx[field] as number
        const value = compute(read) + (variant - 1)
        busyWait(busy)
        ctx[writeField] = value
        return value
      },
    })
  }

  // 第 0 层：解析器
  for (let k = 0; k < PARSER_COUNT; k++) {
    const parser = PARSERS[k]
    const field = `p.${k}`
    registry.set(`parse.${k}`, {
      reads: [INPUT_FIELD],
      writes: [field],
      fn: (ctx) => {
        const value = parser(ctx[INPUT_FIELD] as string) + (variant - 1)
        busyWait(busy)
        ctx[field] = value
        return value
      },
    })
  }

  // 第 1 层叶子（180）：读解析器输出，输出量化分桶（小变化常被桶吸收）
  for (let i = 0; i < L0_COUNT; i++) {
    const field = `l0.${i}`
    if (i < CHAIN_L0) {
      define(`leaf0.${i}`, ['p.3'], field, (read) => i * 1000 + read('p.3'))
    } else {
      const pf = `p.${l0ParserOf(i)}`
      define(`leaf0.${i}`, [pf], field, (read) => i * 1000 + Math.floor(read(pf) / 2))
    }
  }

  // 第 2 层叶子（200）：读第 1 层两个输出
  for (let i = 0; i < L1_COUNT; i++) {
    const field = `l1.${i}`
    if (i < CHAIN_L1) {
      const a = `l0.${i}`
      const b = `l0.${(i + 1) % CHAIN_L0}`
      define(`leaf1.${i}`, [a, b], field, (read) => i * 1000 + ((read(a) % 1000) + (read(b) % 1000)))
    } else {
      const a = `l0.${CHAIN_L0 + ((i * 7) % NORMAL_L0)}`
      const b = `l0.${CHAIN_L0 + ((i * 13 + 5) % NORMAL_L0)}`
      define(`leaf1.${i}`, [a, b], field, (read) => i * 1000 + ((read(a) % 1000) * 2 + (read(b) % 1000)))
    }
  }

  // 第 3 层叶子（160）：读第 2 层输出
  for (let j = 0; j < L2_COUNT; j++) {
    const field = `l2.${j}`
    if (j >= NORMAL_L2) {
      const a = `l1.${j % CHAIN_L1}`
      const b = `l1.${(j * 3 + 1) % CHAIN_L1}`
      define(`leaf2.${j}`, [a, b], field, (read) => j * 1000 + ((read(a) % 1000) * 2 + (read(b) % 1000)))
    } else {
      const a = `l1.${CHAIN_L1 + ((j * 11) % NORMAL_L1)}`
      define(`leaf2.${j}`, [a], field, (read) => j * 1000 + (read(a) % 1000))
    }
  }

  // 汇总函数（40）：只读普通区 l2.[0..127]，不订阅 "!" 专用链
  for (let k = 0; k < AGG_COUNT; k++) {
    const a = `l2.${(k * 3) % NORMAL_L2}`
    const b = `l2.${(k * 7 + 1) % NORMAL_L2}`
    const c = `l2.${(k * 13 + 2) % NORMAL_L2}`
    define(`agg.${k}`, [a, b, c], `agg.${k}`, (read) => (read(a) % 1000) + (read(b) % 1000) + (read(c) % 1000))
  }

  return registry
}
