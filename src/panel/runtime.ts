import { IncrementalEngine } from './engine.ts'
import { buildRegistry, INITIAL_INPUTS } from './registry.ts'
import { RecomputeScheduler } from './scheduler.ts'
import { OutputStore } from './store.ts'

export interface PanelRuntime {
  engine: IncrementalEngine
  scheduler: RecomputeScheduler
  store: OutputStore
  dispose: () => void
}

let current: PanelRuntime | null = null

export function createRuntime(costMs = 0.4): PanelRuntime {
  const engine = new IncrementalEngine()
  for (const entry of buildRegistry({ costMs })) engine.register(entry)
  const store = new OutputStore()
  const scheduler = new RecomputeScheduler(engine, (result) => store.commit(result))
  // 首批：全量计算（engine 初始为 fullRecomputeNeeded）
  scheduler.pushInput({ ...INITIAL_INPUTS })
  return {
    engine,
    scheduler,
    store,
    dispose: () => {
      // 缓存与 DAG 计算结果整体失效
      engine.invalidateAll()
    },
  }
}

export function getRuntime(): PanelRuntime {
  if (!current) current = createRuntime()
  return current
}

// HMR：registry/engine 等模块热替换后，旧运行时的缓存与 DAG 必须整体失效并重建
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    current?.dispose()
    current = null
  })
}
