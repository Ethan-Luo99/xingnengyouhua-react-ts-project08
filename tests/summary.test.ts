import test from 'node:test'
import assert from 'node:assert/strict'
import { IncrementalEngine } from '../src/panel/engine.ts'
import {
  buildRegistry,
  INITIAL_INPUTS,
  KEYSTROKE_INPUT,
  SUMMARY_NAMES,
} from '../src/panel/registry.ts'
import { RecomputeScheduler } from '../src/panel/scheduler.ts'
import { OutputStore } from '../src/panel/store.ts'

function setup() {
  const engine = new IncrementalEngine()
  for (const entry of buildRegistry({ costMs: 0 })) engine.register(entry)
  const store = new OutputStore()
  const scheduler = new RecomputeScheduler(engine, (r) => store.commit(r))
  scheduler.pushInput({ ...INITIAL_INPUTS })
  scheduler.flush()
  return { engine, scheduler, store }
}

/**
 * 模拟 useSyncExternalStore 的语义：store 通知时取快照，
 * 快照引用不变则 React 不 re-render（汇总区 render 计数不增加）。
 */
function createRenderHarness(store: OutputStore) {
  let renders = 0
  let last = store.getSelection(SUMMARY_NAMES)
  const unsubscribe = store.subscribe(() => {
    const next = store.getSelection(SUMMARY_NAMES)
    if (next !== last) {
      last = next
      renders++
    }
  })
  return { get renders() { return renders }, unsubscribe }
}

test('汇总区精准订阅：订阅的 40 个输出未变化时 render 计数为 0', () => {
  const { engine, scheduler, store } = setup()
  // 动态注册一个与汇总区完全无关的函数及其专属输入
  engine.register({
    name: 'unrelated_leaf',
    meta: { reads: ['input.unrelated'], writes: ['out.unrelated_leaf'] },
    fn: (ctx) => {
      const v = String(ctx['input.unrelated']).length
      ctx['out.unrelated_leaf'] = v
      return v
    },
  })
  scheduler.flush() // 让新函数完成首次计算

  const harness = createRenderHarness(store)
  scheduler.pushInput({ 'input.unrelated': 'x'.repeat(99) })
  scheduler.flush()
  assert.equal(harness.renders, 0, '未订阅的输出变化不得触发汇总区 render')
  harness.unsubscribe()
})

test('汇总区订阅：订阅的输出变化时 render 计数 +1，且仅 +1', () => {
  const { scheduler, store } = setup()
  const harness = createRenderHarness(store)
  scheduler.pushInput({ [KEYSTROKE_INPUT]: 'keystroke' })
  scheduler.flush()
  assert.equal(harness.renders, 1)
  harness.unsubscribe()
})

test('汇总区订阅：相同输入重复提交（StrictMode 场景）不触发 render', () => {
  const { scheduler, store } = setup()
  const harness = createRenderHarness(store)
  scheduler.pushInput({ [KEYSTROKE_INPUT]: 'same' })
  scheduler.flush()
  scheduler.pushInput({ [KEYSTROKE_INPUT]: 'same' }) // 值未变
  scheduler.flush()
  assert.equal(harness.renders, 1, '值未变化的批次不得触发额外 render')
  harness.unsubscribe()
})

test('getSelection 快照引用稳定性：未变化返回同一引用', () => {
  const { scheduler, store } = setup()
  const first = store.getSelection(SUMMARY_NAMES)
  scheduler.pushInput({ [KEYSTROKE_INPUT]: 'noop-check' })
  scheduler.flush()
  // 按键会改变部分 summary，快照应更新
  const second = store.getSelection(SUMMARY_NAMES)
  assert.notEqual(second, first)
  // 无新提交时再取，引用必须稳定
  assert.equal(store.getSelection(SUMMARY_NAMES), second)
})
