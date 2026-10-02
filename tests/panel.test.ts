import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CycleError, IncrementalEngine, OrderError } from '../src/panel/engine.ts'
import { buildRegistry, INPUT_FIELD, TOTAL_COUNT } from '../src/panel/registry.ts'
import { PanelStore } from '../src/panel/store.ts'
import type { Ctx, Registry } from '../src/panel/types.ts'

const makeEngine = (variant = 1) =>
  new IncrementalEngine(buildRegistry({ busyWaitMs: 0, variant }), {})

const allOutputFields = (registry: Registry): string[] => {
  const fields: string[] = []
  for (const entry of registry.values()) fields.push(...entry.writes)
  return fields
}

const FIELDS = allOutputFields(buildRegistry({ busyWaitMs: 0 }))

const snapshotOf = (engine: IncrementalEngine, fields: string[]) =>
  fields.map((field) => engine.ctx[field])

const diffSnapshots = (a: unknown[], b: unknown[], fields: string[]): string[] => {
  const diffs: string[] = []
  a.forEach((value, i) => {
    if (!Object.is(value, b[i])) diffs.push(`${fields[i]}: ${String(value)} !== ${String(b[i])}`)
  })
  return diffs
}

test('等价性：增量重算与全量执行的 600 个输出快照 diff 为空', () => {
  const incremental = makeEngine()
  const baseline = makeEngine()
  const inputs = [
    'H', 'He', 'Hey', 'Hey!', 'Hey! ', 'Hey! a', 'Hey! ab', 'Hey! abc',
    'Hey! abc1', 'Hey! abc12', 'Hey! abc12,', 'Hey! abc12,#', 'Hey! abc12,#?',
  ]
  const allDiffs: string[] = []
  for (const text of inputs) {
    incremental.applyInput({ [INPUT_FIELD]: text })
    baseline.runFull({ [INPUT_FIELD]: text })
    allDiffs.push(...diffSnapshots(snapshotOf(incremental, FIELDS), snapshotOf(baseline, FIELDS), FIELDS))
  }
  assert.equal(FIELDS.length, TOTAL_COUNT)
  assert.deepEqual(allDiffs, [])
})

test('汇总区精准订阅：未触及 40 个 agg 依赖的输入不触发 render', () => {
  const store = new PanelStore(buildRegistry({ busyWaitMs: 0 }))
  let renders = 0
  let last = store.getAggSnapshot()
  store.subscribe(() => {
    const next = store.getAggSnapshot()
    if (next !== last) {
      renders++
      last = next
    }
  })
  store.setInput('aaaaaaaa') // 首次全量：汇总区拿到值
  assert.equal(renders, 1)
  // 只命中 "!" 专用链（leaf0[0..15] -> leaf1[0..15] -> leaf2[128..159]），无任何 agg 订阅
  for (const text of ['aaaaaaaa!', 'aaaaaaaa!!', 'aaaaaaaa!!!', 'aaaaaaaa!!!!']) {
    store.setInput(text)
    assert.ok(store.engine.getStats().executed > 0, '确实发生了增量重算')
  }
  assert.equal(renders, 1) // 快照引用未变 => React 不会重渲染 SummaryPanel
  store.setInput('aaaaaaaa!!!!' + 'a'.repeat(16)) // 跨越量化边界，agg 值变化
  assert.equal(renders, 2)
})

test('动态增删：DAG 增量重建，下游正确重算', () => {
  const a = makeEngine()
  const b = makeEngine()
  a.applyInput({ [INPUT_FIELD]: 'seed' })
  b.runFull({ [INPUT_FIELD]: 'seed' })

  const extra = {
    reads: ['l2.5'],
    writes: ['t.extra'],
    fn: (ctx: Ctx) => {
      ctx['t.extra'] = (ctx['l2.5'] as number) + 1
    },
  }
  a.registerFunction('extra.tail', extra)
  b.registerFunction('extra.tail', extra)
  a.applyInput({ [INPUT_FIELD]: 'seed!' })
  b.runFull({ [INPUT_FIELD]: 'seed!' })
  const fields1 = [...FIELDS, 't.extra']
  assert.deepEqual(diffSnapshots(snapshotOf(a, fields1), snapshotOf(b, fields1), fields1), [])

  a.unregisterFunction('leaf0.100')
  b.unregisterFunction('leaf0.100')
  assert.equal(a.size, b.size)
  a.applyInput({ [INPUT_FIELD]: 'seed!!' })
  b.runFull({ [INPUT_FIELD]: 'seed!!' })
  const fields2 = [...fields1.filter((f) => f !== 'l0.100')]
  assert.deepEqual(diffSnapshots(snapshotOf(a, fields2), snapshotOf(b, fields2), fields2), [])
})

test('环检测：成环注册报错并拒绝注册（回滚无残留）', () => {
  const engine = new IncrementalEngine(new Map(), {})
  const noop = () => 0
  engine.registerFunction('a', { reads: ['s.c'], writes: ['s.a'], fn: noop })
  engine.registerFunction('b', { reads: ['s.a'], writes: ['s.b'], fn: noop })
  // c 写 s.c，而 a 读 s.c：c -> a -> b -> c 成环
  assert.throws(
    () => engine.registerFunction('c', { reads: ['s.b'], writes: ['s.c'], fn: noop }),
    CycleError,
  )
  assert.equal(engine.size, 2)
  // 顺序兼容：新函数写出的字段不能被已注册函数读取（拓扑序须与插入序等价）
  assert.throws(
    () => engine.registerFunction('g', { reads: [], writes: ['s.c'], fn: noop }),
    OrderError,
  )
  assert.equal(engine.size, 2)
  // 写字段冲突：一个字段只能有一个写入者
  assert.throws(
    () => engine.registerFunction('d', { reads: [], writes: ['s.a'], fn: noop }),
    /已有写入者/,
  )
  assert.equal(engine.size, 2)
})

test('HMR：热替换函数实现后缓存与 DAG 整体失效', () => {
  const engine = makeEngine(1)
  engine.applyInput({ [INPUT_FIELD]: 'hello hmr' })
  const before = snapshotOf(engine, FIELDS)

  engine.replaceRegistry(buildRegistry({ busyWaitMs: 0, variant: 2 }))
  assert.equal(engine.size, TOTAL_COUNT) // 无重复注册

  const stats = engine.applyInput({ [INPUT_FIELD]: 'hello hmr!' })
  assert.equal(stats.executed, TOTAL_COUNT) // 整体失效 => 全量重算
  const after = snapshotOf(engine, FIELDS)
  after.forEach((value, i) => {
    assert.notEqual(value, before[i], `字段 ${FIELDS[i]} 应反映新实现`)
  })
})

test('StrictMode：mount effect 双调用不污染 ctx（幂等初始化）', async () => {
  const registry = buildRegistry({ busyWaitMs: 0 })
  registry.set('side.counter', {
    reads: ['t.count'],
    writes: ['t.count'],
    fn: (ctx) => {
      ctx['t.count'] = ((ctx['t.count'] as number) ?? 0) + 1
    },
  })
  const engine = new IncrementalEngine(registry, { [INPUT_FIELD]: '' })
  // 模拟 StrictMode 双调用 mount effect
  await Promise.all([engine.ensureComputed(), engine.ensureComputed()])
  await engine.ensureComputed()
  assert.equal(engine.ctx['t.count'], 1) // 若副作用泄漏，这里会变成 2+
})

test('版本号丢弃过期批次：旧批次结果不得覆盖新结果', async () => {
  const registry: Registry = new Map()
  for (let i = 0; i < 5; i++) {
    const reads = i === 0 ? [INPUT_FIELD] : [`v.${i - 1}`]
    registry.set(`f.${i}`, {
      reads,
      writes: [`v.${i}`],
      fn: (ctx) => {
        const base = i === 0 ? (ctx[INPUT_FIELD] as string) : (ctx[`v.${i - 1}`] as string)
        ctx[`v.${i}`] = base + String(i)
      },
    })
  }
  const engine = new IncrementalEngine(registry, {})
  const stale = engine.applyInputChunked({ [INPUT_FIELD]: 'a' }, 0) // budget 0：每个函数后让出
  await new Promise((resolve) => setTimeout(resolve, 0)) // 让旧批次先跑一个切片
  const fresh = engine.applyInput({ [INPUT_FIELD]: 'ab' }) // 新批次同步提交
  const staleStats = await stale
  assert.equal(staleStats.aborted, true)
  assert.equal(fresh.aborted, false)
  assert.equal(engine.ctx['v.4'], 'ab01234') // ctx 只反映新批次
})

test('Proxy 读追踪兜底隐式依赖：漏声明时自动补边', () => {
  const registry: Registry = new Map()
  registry.set('a', {
    reads: [INPUT_FIELD],
    writes: ['x'],
    fn: (ctx) => {
      ctx['x'] = (ctx[INPUT_FIELD] as string).length
    },
  })
  registry.set('b', {
    reads: [], // 故意漏声明对 x 的依赖
    writes: ['y'],
    fn: (ctx) => {
      ctx['y'] = (ctx['x'] as number) * 2
    },
  })
  const implicit: string[] = []
  const engine = new IncrementalEngine(registry, {}, {
    onImplicitDep: (fn, field) => implicit.push(`${fn}:${field}`),
  })
  engine.applyInput({ [INPUT_FIELD]: 'abc' })
  assert.equal(engine.ctx['y'], 6)
  assert.deepEqual(implicit, ['b:x']) // 隐式依赖被发现并补边
  engine.applyInput({ [INPUT_FIELD]: 'abcdef' })
  assert.equal(engine.ctx['y'], 12) // 没有兜底时这里会停留在 6（脏缓存）
})
