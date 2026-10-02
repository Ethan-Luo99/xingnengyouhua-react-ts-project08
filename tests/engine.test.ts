import test from 'node:test'
import assert from 'node:assert/strict'
import { CycleError, IncrementalEngine } from '../src/panel/engine.ts'
import {
  buildRegistry,
  INITIAL_INPUTS,
  KEYSTROKE_INPUT,
  TOTAL_COUNT,
} from '../src/panel/registry.ts'
import type { Ctx } from '../src/panel/types.ts'

function makeEngine(costMs = 0): IncrementalEngine {
  const engine = new IncrementalEngine()
  for (const entry of buildRegistry({ costMs })) engine.register(entry)
  return engine
}

function fullCompute(engine: IncrementalEngine, inputs: Ctx) {
  engine.invalidateAll()
  const changed = engine.applyInputs(inputs)
  return engine.recompute(changed)
}

test('注册表规模：600 个函数（560 叶子 + 40 汇总）', () => {
  const engine = makeEngine()
  assert.equal(engine.size, TOTAL_COUNT)
  assert.equal(TOTAL_COUNT, 600)
})

test('全量执行耗时 > 200ms（0.4ms × 600）', () => {
  const engine = makeEngine(0.4)
  const result = fullCompute(engine, { ...INITIAL_INPUTS })
  assert.equal(result.executed.length, 600)
  assert.ok(result.durationMs > 200, `expected > 200ms, got ${result.durationMs}`)
})

test('优化前后全量输出等价：600 个输出快照 diff 为空', () => {
  const inputsV0 = { ...INITIAL_INPUTS }
  const inputsV1 = { ...INITIAL_INPUTS, [KEYSTROKE_INPUT]: 'user-typed-text' }

  // 基线：新输入下直接全量计算
  const baseline = makeEngine()
  const full = fullCompute(baseline, inputsV1)

  // 优化路径：旧输入全量 -> 按键增量重算
  const incremental = makeEngine()
  fullCompute(incremental, inputsV0)
  const changed = incremental.applyInputs(inputsV1)
  const inc = incremental.recompute(changed)

  assert.ok(inc.executed.length < 600, '增量路径不应全量执行')
  const diff = Object.keys(full.outputs).filter(
    (key) => !Object.is(full.outputs[key], inc.outputs[key]),
  )
  assert.deepEqual(diff, [], `600 个输出快照 diff 必须为空，差异: ${diff.join(',')}`)
})

test('单次按键增量重算 < 100 个函数（预期 62 个）', () => {
  const engine = makeEngine()
  fullCompute(engine, { ...INITIAL_INPUTS })
  const changed = engine.applyInputs({ [KEYSTROKE_INPUT]: 'a' })
  const result = engine.recompute(changed)
  assert.equal(result.executed.length, 62)
  assert.ok(result.executed.length < 100)
})

test('拓扑序与原插入序等价（无回边时）', () => {
  const engine = makeEngine()
  const order = engine.getTopoOrder()
  const registry = buildRegistry({ costMs: 0 })
  assert.deepEqual(order, registry.map((e) => e.name))
})

test('动态注册：新函数纳入执行序列且顺序正确', () => {
  const engine = makeEngine()
  fullCompute(engine, { ...INITIAL_INPUTS })
  engine.register({
    name: 'extra_leaf',
    meta: { reads: ['out.leaf2_0'], writes: ['out.extra_leaf'] },
    fn: (ctx) => {
      const v = Number(ctx['out.leaf2_0']) + 1
      ctx['out.extra_leaf'] = v
      return v
    },
  })
  assert.equal(engine.size, 601)
  const result = engine.recompute([])
  assert.ok(result.executed.includes('extra_leaf'))
  assert.equal(result.outputs['extra_leaf'], Number(result.outputs['leaf2_0']) + 1)
  // 拓扑序中 extra_leaf 必须排在 leaf2_0 之后
  const order = engine.getTopoOrder()
  assert.ok(order.indexOf('extra_leaf') > order.indexOf('leaf2_0'))
})

test('动态注销：下游闭包被重算，写入字段从 ctx 清除', () => {
  const engine = makeEngine()
  fullCompute(engine, { ...INITIAL_INPUTS })
  engine.unregister('leaf2_0')
  assert.equal(engine.size, 599)
  assert.equal(engine.ctx['out.leaf2_0'], undefined)
  // summary_00 读 out.leaf2_0，应被标记重算
  const result = engine.recompute([])
  assert.ok(result.executed.includes('summary_00'))
  assert.ok(!result.executed.includes('leaf2_0'))
  // 再注册回来（前向引用场景），不应报错
  engine.register({
    name: 'leaf2_0',
    meta: { reads: ['out.leaf1_0', 'out.leaf1_40'], writes: ['out.leaf2_0'] },
    fn: (ctx) => {
      const v = Number(ctx['out.leaf1_0']) + Number(ctx['out.leaf1_40'])
      ctx['out.leaf2_0'] = v
      return v
    },
  })
  const result2 = engine.recompute([])
  assert.ok(result2.executed.includes('leaf2_0'))
})

test('环检测：成环时报错并拒绝注册，注册表不被污染', () => {
  const engine = new IncrementalEngine()
  engine.register({
    name: 'a',
    meta: { reads: ['input.x'], writes: ['out.a'] },
    fn: (ctx) => (ctx['out.a'] = Number(ctx['input.x']) + 1),
  })
  engine.register({
    name: 'b',
    meta: { reads: ['out.a'], writes: ['out.b'] },
    fn: (ctx) => (ctx['out.b'] = Number(ctx['out.a']) + 1),
  })
  // c 读 out.b、写 input.x → 形成 a -> b -> c -> a 的环
  assert.throws(
    () =>
      engine.register({
        name: 'c',
        meta: { reads: ['out.b'], writes: ['input.x'] },
        fn: (ctx) => (ctx['input.x'] = Number(ctx['out.b'])),
      }),
    CycleError,
  )
  assert.equal(engine.size, 2, '成环注册必须被拒绝')
  assert.deepEqual(engine.getTopoOrder(), ['a', 'b'], 'DAG 不得被失败注册污染')
})

test('HMR 失效：invalidateAll 后缓存整体失效，下一批全量重算并反映新实现', () => {
  const engine = makeEngine()
  fullCompute(engine, { ...INITIAL_INPUTS })
  const genBefore = engine.generation

  // 模拟 HMR：热替换 leaf1_0 的实现
  engine.unregister('leaf1_0')
  engine.register({
    name: 'leaf1_0',
    meta: { reads: ['out.leaf0_0', 'out.leaf0_1'], writes: ['out.leaf1_0'] },
    fn: (ctx) => {
      const v = 999999
      ctx['out.leaf1_0'] = v
      return v
    },
  })
  engine.invalidateAll()

  assert.equal(engine.generation, genBefore + 1)
  const result = engine.recompute([])
  assert.equal(result.executed.length, 600, '失效后必须全量重算')
  assert.equal(result.outputs['leaf1_0'], 999999, '必须反映热替换后的新实现')
})

test('Proxy 审计：生成的注册表声明完备，无隐式依赖', () => {
  const engine = makeEngine()
  fullCompute(engine, { ...INITIAL_INPUTS })
  assert.deepEqual(engine.auditDeclarations(), [])
})

test('Proxy 审计：能检出未声明的隐式依赖', () => {
  const engine = new IncrementalEngine()
  engine.register({
    name: 'sneaky',
    meta: { reads: ['input.x'], writes: ['out.sneaky'] },
    fn: (ctx) => (ctx['out.sneaky'] = Number(ctx['input.x']) + Number(ctx['input.secret'])),
  })
  const problems = engine.auditDeclarations()
  assert.equal(problems.length, 1)
  assert.deepEqual(problems[0].undeclared, ['input.secret'])
})

test('降级策略：未声明 reads 的函数每批保守重算', () => {
  const engine = new IncrementalEngine()
  let calls = 0
  engine.register({
    name: 'legacy',
    meta: { reads: undefined, writes: ['out.legacy'] },
    fn: (ctx) => {
      calls++
      ctx['out.legacy'] = calls
      return calls
    },
  })
  engine.recompute([])
  engine.recompute([])
  engine.recompute([])
  assert.equal(calls, 3, '未声明 reads 的函数必须每批重算')
})
