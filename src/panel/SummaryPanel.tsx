import { memo, useSyncExternalStore } from 'react'
import { summaryRenderStats } from './metrics.ts'
import { SUMMARY_NAMES } from './registry.ts'
import { getRuntime } from './runtime.ts'

/**
 * 汇总区：独立组件，精准订阅其依赖的 40 个汇总函数输出。
 * getSelection 在 40 个值均未变化时返回缓存引用，
 * useSyncExternalStore 判定快照不变，本组件不 re-render。
 */
export const SummaryPanel = memo(function SummaryPanel() {
  const runtime = getRuntime()
  const values = useSyncExternalStore(runtime.store.subscribe, () =>
    runtime.store.getSelection(SUMMARY_NAMES),
  )
  summaryRenderStats.count++
  return (
    <section className="summary-panel">
      <h2>汇总区（{SUMMARY_NAMES.length} 项）</h2>
      <ul>
        {SUMMARY_NAMES.map((name, i) => (
          <li key={name}>
            <code>{name}</code>: {String(values[i] ?? '—')}
          </li>
        ))}
      </ul>
    </section>
  )
})
