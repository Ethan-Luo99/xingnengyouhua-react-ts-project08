import { useEffect, useState } from 'react'
import { panelStore } from './panel/index.ts'
import { useStatsSnapshot } from './panel/react.ts'
import { SummaryPanel } from './panel/SummaryPanel.tsx'

export default function App() {
  const [text, setText] = useState('')
  const stats = useStatsSnapshot()

  useEffect(() => {
    // StrictMode 下 effect 双调用：ensureComputed 幂等，600 个函数只会执行一轮
    void panelStore.initialize()
  }, [])

  return (
    <main>
      <h1>函数执行监控面板</h1>
      <label>
        输入（每次按键触发增量重算）：
        <input
          value={text}
          onChange={(event) => {
            const next = event.target.value
            setText(next) // 回显：高优先级
            panelStore.setInput(next) // 重算：事件层驱动，绝不在 render 内执行
          }}
        />
      </label>
      <p>
        最近一批 v{stats.version}：重算 {stats.executed} / 跳过 {stats.skipped} 个函数， 主线程阻塞{' '}
        {stats.durationMs.toFixed(1)}ms
      </p>
      <SummaryPanel />
    </main>
  )
}
