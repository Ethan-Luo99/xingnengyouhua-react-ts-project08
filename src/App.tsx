import { useEffect, useState } from 'react'
import { panelStore } from './panel/index.ts'
import { useStatsSnapshot } from './panel/react.ts'
import { SummaryPanel } from './panel/SummaryPanel.tsx'

export default function App() {
  const [text, setText] = useState('')
  const [undoDepth, setUndoDepth] = useState(0)
  const [redoDepth, setRedoDepth] = useState(0)
  const [lastError, setLastError] = useState<string | null>(null)
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
            const result = panelStore.setInput(next)
            setUndoDepth(panelStore.getUndoDepth())
            setRedoDepth(panelStore.getRedoDepth())
            setLastError(result.failed ? '上一批次执行失败，已整体回滚' : null)
            if (result.failed) setText(String(panelStore.engine.ctx['input.text'] ?? ''))
          }}
        />
      </label>
      <button
        type="button"
        disabled={undoDepth === 0}
        onClick={() => {
          if (panelStore.getUndoDepth() === 0) return
          const result = panelStore.undoLastBatch()
          setUndoDepth(panelStore.getUndoDepth())
          setRedoDepth(panelStore.getRedoDepth())
          setLastError(result.failed ? '撤销批次执行失败，已回滚' : null)
          setText(String(panelStore.engine.ctx['input.text'] ?? ''))
        }}
      >
        撤销上一批次（剩 {undoDepth} 层）
      </button>
      <button
        type="button"
        disabled={redoDepth === 0}
        onClick={() => {
          if (panelStore.getRedoDepth() === 0) return
          const result = panelStore.redoLastUndo()
          setUndoDepth(panelStore.getUndoDepth())
          setRedoDepth(panelStore.getRedoDepth())
          setLastError(result.failed ? '重做批次执行失败，已回滚' : null)
          setText(String(panelStore.engine.ctx['input.text'] ?? ''))
        }}
      >
        重做（剩 {redoDepth} 层）
      </button>
      <p>
        最近一批 v{stats.version}：重算 {stats.executed} / 跳过 {stats.skipped} 个函数， 主线程阻塞{' '}
        {stats.durationMs.toFixed(1)}ms{stats.reverted ? '（undo 增量恢复）' : ''}
        {stats.redone ? '（redo 增量恢复）' : ''}
        {stats.failed ? '，批次失败已回滚' : ''}
      </p>
      {lastError ? <p role="alert">{lastError}</p> : null}
      <SummaryPanel />
    </main>
  )
}
