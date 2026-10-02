import { useSyncExternalStore } from 'react'
import { panelStore } from './index.ts'
import type { RunStats } from './types.ts'

export function useStatsSnapshot(): RunStats {
  return useSyncExternalStore(panelStore.subscribe, panelStore.getStatsSnapshot)
}

export function useAggSnapshot(): readonly unknown[] {
  return useSyncExternalStore(panelStore.subscribe, panelStore.getAggSnapshot)
}
