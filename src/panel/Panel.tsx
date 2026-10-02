import { useEffect, useState, useSyncExternalStore } from 'react'
import { KEYSTROKE_INPUT } from './registry.ts'
import { getRuntime } from './runtime.ts'
import { SummaryPanel } from './SummaryPanel.tsx'
import './panel.css'

/**
 * 函数执行监控面板。
 * 重算只在事件/effect 层驱动（render 纯读快照），StrictMode 双调用安全：
 * 双挂载的 effect 会推入相同输入，applyInputs 判定无变化，不会重复执行。
 */
export function Panel() {
  const runtime = getRuntime()
  const [text, setText] = useState('')
  const stats = useSyncExternalStore(runtime.store.subscribe, () => runtime.store.getStats())

  useEffect(() => {
    runtime.scheduler.pushInput({ [KEYSTROKE_INPUT]: text })
  }, [runtime, text])

  return (
    <section className="panel">
      <h1>函数执行监控面板</h1>
      <label>
        输入（每次按键触发增量重算）：
        <input value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <p className="stats">
        {stats
          ? `最近批次 #${stats.executedCount} 个函数重算，耗时 ${stats.durationMs.toFixed(1)}ms`
          : '计算中…'}
      </p>
      <SummaryPanel />
    </section>
  )
}
