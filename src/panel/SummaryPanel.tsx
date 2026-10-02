import { memo } from 'react'
import { useAggSnapshot } from './react.ts'
import { bumpSummaryRenderCount, getSummaryRenderCount } from './summaryMetrics.ts'

/** 汇总区：独立组件 + memo，精准订阅 40 个 agg 输出，快照引用不变则不重渲染 */
export const SummaryPanel = memo(function SummaryPanel() {
  const aggs = useAggSnapshot()
  bumpSummaryRenderCount()
  return (
    <section>
      <h2>
        汇总区（{aggs.length} 项，已渲染 {getSummaryRenderCount()} 次）
      </h2>
      <ol>
        {aggs.map((value, i) => (
          <li key={i}>{String(value)}</li>
        ))}
      </ol>
    </section>
  )
})
