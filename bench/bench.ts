import assert from 'node:assert/strict'
import { IncrementalEngine } from '../src/panel/engine.ts'
import { buildRegistry, INPUT_FIELD, TOTAL_COUNT } from '../src/panel/registry.ts'

/**
 * 基准：模拟连续按键，对比"优化前全量重算"与"优化后增量重算"。
 * 断言：单次按键重算函数数 < 100、单次主线程阻塞 < 50ms。
 */
const TYPING = 'Hey! Type 42 chars, ok.'

interface Row {
  input: string
  executed: number
  durationMs: number
}

const maxOf = (rows: Row[], key: 'executed' | 'durationMs') => Math.max(...rows.map((r) => r[key]))
const avgOf = (rows: Row[], key: 'executed' | 'durationMs') =>
  rows.reduce((sum, r) => sum + r[key], 0) / rows.length

// ---- 优化前基线：每次按键全量执行 600 个函数 ----
const baseline = new IncrementalEngine(buildRegistry(), {}, { trackReadsWithProxy: false })
const baselineRows: Row[] = []
for (let i = 1; i <= TYPING.length; i++) {
  const input = TYPING.slice(0, i)
  const stats = baseline.runFull({ [INPUT_FIELD]: input })
  baselineRows.push({ input, executed: stats.executed, durationMs: stats.durationMs })
}

// ---- 优化后：dirty 传播增量重算（首帧全量 = 应用启动初始化） ----
const optimized = new IncrementalEngine(buildRegistry(), {})
optimized.runFull({ [INPUT_FIELD]: '' })
const optimizedRows: Row[] = []
for (let i = 1; i <= TYPING.length; i++) {
  const input = TYPING.slice(0, i)
  const stats = optimized.applyInput({ [INPUT_FIELD]: input })
  optimizedRows.push({ input, executed: stats.executed, durationMs: stats.durationMs })
}

// ---- 对比报告 ----
console.log('函数执行监控面板 — 增量重算基准报告')
console.log(`注册函数总数: ${TOTAL_COUNT}（每次按键的输入序列: ${JSON.stringify(TYPING)}）`)
console.log('')
console.log('按键 | 基线:函数数 | 基线:阻塞ms | 优化后:函数数 | 优化后:阻塞ms')
for (let i = 0; i < TYPING.length; i++) {
  const b = baselineRows[i]
  const o = optimizedRows[i]
  console.log(
    `${JSON.stringify(b.input.slice(-1)).padStart(6)} | ${String(b.executed).padStart(11)} | ${b.durationMs.toFixed(1).padStart(11)} | ${String(o.executed).padStart(13)} | ${o.durationMs.toFixed(1).padStart(13)}`,
  )
}
console.log('')
console.log(`基线   平均/峰值: ${avgOf(baselineRows, 'executed').toFixed(0)} 个函数, ${avgOf(baselineRows, 'durationMs').toFixed(1)}ms / ${maxOf(baselineRows, 'durationMs').toFixed(1)}ms`)
console.log(`优化后 平均/峰值: ${avgOf(optimizedRows, 'executed').toFixed(0)} 个函数, ${avgOf(optimizedRows, 'durationMs').toFixed(1)}ms / ${maxOf(optimizedRows, 'durationMs').toFixed(1)}ms`)

// ---- 断言 ----
assert.ok(avgOf(baselineRows, 'durationMs') > 200, '场景前提：全量执行应 > 200ms')
assert.ok(baselineRows.every((r) => r.executed === TOTAL_COUNT), '基线每次按键应全量执行')
assert.ok(maxOf(optimizedRows, 'executed') < 100, `单次按键重算函数数应 < 100，实际峰值 ${maxOf(optimizedRows, 'executed')}`)
assert.ok(maxOf(optimizedRows, 'durationMs') < 50, `单次阻塞应 < 50ms，实际峰值 ${maxOf(optimizedRows, 'durationMs').toFixed(1)}ms`)
console.log('')
console.log('PASS: 单次按键重算函数数 < 100 且单次主线程阻塞 < 50ms')
