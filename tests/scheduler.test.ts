import test from 'node:test'
import assert from 'node:assert/strict'
import { IncrementalEngine } from '../src/panel/engine.ts'
import { buildRegistry, INITIAL_INPUTS, KEYSTROKE_INPUT } from '../src/panel/registry.ts'
import { RecomputeScheduler } from '../src/panel/scheduler.ts'
import type { RecomputeResult } from '../src/panel/types.ts'

function setup() {
  const engine = new IncrementalEngine()
  for (const entry of buildRegistry({ costMs: 0 })) engine.register(entry)
  const commits: RecomputeResult[] = []
  const scheduler = new RecomputeScheduler(engine, (r) => commits.push(r))
  return { engine, scheduler, commits }
}

test('连续输入合并为最新批次：过期批次不执行、不提交', () => {
  const { scheduler, commits } = setup()
  scheduler.pushInput({ [KEYSTROKE_INPUT]: 'a' }) // v1
  scheduler.pushInput({ [KEYSTROKE_INPUT]: 'ab' }) // v2
  scheduler.pushInput({ [KEYSTROKE_INPUT]: 'abc' }) // v3
  scheduler.flush()
  assert.equal(commits.length, 1, '三轮输入只应提交一次')
  assert.equal(scheduler.committed, 3)
  assert.equal(scheduler.lastStats?.version, 3)
})

test('旧批次结果不得覆盖新结果（执行期间重入新批次则丢弃本批）', () => {
  const engine = new IncrementalEngine()
  const commits: RecomputeResult[] = []
  const scheduler = new RecomputeScheduler(engine, (r) => commits.push(r))
  // 业务函数内重入 pushInput：本批结果应立即过期
  engine.register({
    name: 'reentrant',
    meta: { reads: ['input.x'], writes: ['out.reentrant'] },
    fn: (ctx) => {
      const v = String(ctx['input.x'])
      if (v === 'old') scheduler.pushInput({ 'input.x': 'new' })
      ctx['out.reentrant'] = v
      return v
    },
  })
  scheduler.pushInput({ 'input.x': 'old' })
  scheduler.flush()
  assert.equal(scheduler.discardedBatches, 1, '过期批次必须被丢弃')
  assert.equal(commits.length, 0, '过期批次不得提交')
  // 下一批（new）正常提交，最终结果只能是 new
  scheduler.flush()
  assert.equal(commits.length, 1)
  assert.equal(commits[0].outputs['reentrant'], 'new')
})

test('StrictMode 双调用安全：相同输入重复推送不产生重复执行', () => {
  const { engine, scheduler, commits } = setup()
  let sideEffects = 0
  engine.register({
    name: 'counter',
    meta: { reads: [KEYSTROKE_INPUT], writes: ['out.counter'] },
    fn: (ctx) => {
      sideEffects++
      ctx['out.counter'] = sideEffects
      return sideEffects
    },
  })
  // 模拟 StrictMode 双挂载 effect：同一输入推两次
  scheduler.pushInput({ [KEYSTROKE_INPUT]: 'hello' })
  scheduler.pushInput({ [KEYSTROKE_INPUT]: 'hello' })
  scheduler.flush()
  const afterFirst = sideEffects
  scheduler.flush() // 重复 flush 不得再执行
  assert.equal(sideEffects, afterFirst, '相同输入不得触发重复执行')
  assert.equal(engine.ctx['out.counter'], afterFirst, 'ctx 中的累加型字段不得翻倍')
  assert.ok(commits.length >= 1)
})

test('相同值的输入补丁不触发任何重算（applyInputs 幂等）', () => {
  const { engine, scheduler } = setup()
  scheduler.pushInput({ ...INITIAL_INPUTS })
  scheduler.flush()
  scheduler.pushInput({ ...INITIAL_INPUTS }) // 完全相同的值
  scheduler.flush()
  assert.equal(scheduler.lastStats?.executedCount, 0)
  void engine
})
