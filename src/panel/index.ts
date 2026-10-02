import { buildRegistry } from './registry.ts'
import { PanelStore } from './store.ts'

export const panelStore = new PanelStore(buildRegistry())

// HMR：registry 模块被热替换 => 函数实现已变化，缓存与 DAG 必须整体失效
if (import.meta.hot) {
  import.meta.hot.accept('./registry.ts', (mod) => {
    panelStore.replaceRegistry((mod ?? { buildRegistry }).buildRegistry())
  })
}
