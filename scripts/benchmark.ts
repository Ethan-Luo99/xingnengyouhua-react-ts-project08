/**
 * 基准脚本：模拟单次按键，对比"优化前基线（全量）vs 优化后（增量）"。
 * 运行：npm run bench
 * 断言：重算函数数 < 100、单次主线程阻塞 < 50ms。
 */
import assert from 'node:assert/strict'
import { IncrementalEngine } from '../src/panel/engine.ts'
import {
  buildRegistry,
  INITIAL_INPUTS,
  KEYSTROKE_INPUT,
  TOTAL_COUNT,
} from '../src/panel/registry.ts'

const COST_MS = 0.4

function measureBaseline(): { count: number; ms: number } {
  // 优化前：每次按键全量执行 600 个函数
  const engine = new IncrementalEngine()
  for (const entry of buildRegistry({ costMs: COST_MS })) engine.register(entry)
  engine.applyInputs({ ...INITIAL_INPUTS, [KEYSTROKE_INPUT]: 'keystroke' })
  const result = engine.recompute([]) // fullRecomputeNeeded -> 全量
  return { count: result.executed.length, ms: result.durationMs }
}

function measureOptimized(): { count: number; ms: number } {
  // 优化后：dirty 传播，只重算受影响子图
  const engine = new IncrementalEngine()
  for (const entry of buildRegistry({ costMs: COST_MS })) engine.register(entry)
  engine.applyInputs({ ...INITIAL_INPUTS })
  engine.recompute([]) // 初始全量（不计入按键成本）
  const changed = engine.applyInputs({ [KEYSTROKE_INPUT]: 'keystroke' })
  const result = engine.recompute(changed)
  return { count: result.executed.length, ms: result.durationMs }
}

const baseline = measureBaseline()
const optimized = measureOptimized()

console.log('========== 单次按键重算基准报告 ==========')
console.log(`函数注册表规模:        ${TOTAL_COUNT} 个 (560 叶子 + 40 汇总)`)
console.log(`单函数同步耗时:        ~${COST_MS}ms (busy-wait)`)
console.log('------------------------------------------')
console.log(`优化前基线（全量）:    ${baseline.count} 个函数, 阻塞 ${baseline.ms.toFixed(1)}ms`)
console.log(`优化后（增量）:        ${optimized.count} 个函数, 阻塞 ${optimized.ms.toFixed(1)}ms`)
console.log('------------------------------------------')
console.log(`重算函数数下降:        ${((1 - optimized.count / baseline.count) * 100).toFixed(1)}%`)
console.log(`主线程阻塞下降:        ${((1 - optimized.ms / baseline.ms) * 100).toFixed(1)}%`)
console.log('==========================================')

assert.equal(baseline.count, TOTAL_COUNT, '基线必须是全量 600 个函数')
assert.ok(baseline.ms > 200, `基线阻塞应 > 200ms, 实际 ${baseline.ms.toFixed(1)}ms`)
assert.ok(optimized.count < 100, `重算函数数应 < 100, 实际 ${optimized.count}`)
assert.ok(optimized.ms < 50, `单次阻塞应 < 50ms, 实际 ${optimized.ms.toFixed(1)}ms`)
console.log('断言通过: 重算函数数 < 100 且单次阻塞 < 50ms')
