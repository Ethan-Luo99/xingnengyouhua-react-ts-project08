# 函数执行监控面板 + 增量重算

600 个业务函数（560 叶子 + 40 汇总）共享单个可变 `ctx`，按 Map 插入序执行；
输入变化时只重算受影响子图，汇总区精准订阅 40 个输出。

## 结构

| 文件 | 职责 |
|---|---|
| `registry.ts` | 生成 600 个函数（4 层真实依赖链，每个 busy-wait ~0.4ms，全量 ~240ms） |
| `engine.ts` | DAG 构建、拓扑排序、dirty 传播、环检测、动态增删、HMR 失效、Proxy 审计 |
| `scheduler.ts` | 版本化批次调度：连续输入合批，过期批次丢弃 |
| `store.ts` | 输出 store，选中值未变时 `getSelection` 返回缓存引用 |
| `SummaryPanel.tsx` | 汇总区独立组件，`useSyncExternalStore` 精准订阅 40 个输出 |
| `Panel.tsx` | 输入框 + 状态展示；重算只在事件/effect 层驱动，render 纯读快照 |
| `runtime.ts` | 单例装配 + `import.meta.hot.dispose` 整体失效 |

## 关键设计取舍

### 第 4 条决策：只信显式声明，Proxy 不做运行时兜底

**选择：显式 `reads`/`writes` 声明为唯一事实来源；Proxy 仅用于开发期审计。**

理由：

1. **对象身份**：Proxy 包装后 `ctx !== proxiedCtx`，破坏"共享单个可变 ctx"语义。
   函数若把 ctx 引用存入闭包或外部变量，读追踪立即无声失效——这正是最危险的脏缓存来源。
2. **热路径开销**：600 函数 × 每函数字段读都过 Proxy trap，且每个函数执行前都要重新
   包装，在"单次阻塞 < 50ms"的预算里不可忽略。
3. **可审计性**：显式声明可以静态检查、可以在注册期做环检测；隐式追踪只能事后发现。

降级策略（两道防线）：

- **保守重算**：`reads` 未声明（`undefined`）的函数进入 `alwaysDirty` 集合，每个批次
  无条件重算——正确性优先，性能退化为该函数不参与增量优化。
- **开发期审计**：`engine.auditDeclarations()` 用 Proxy 在 ctx 克隆上真实执行每个函数，
  记录实际读取并与声明比对，发现隐式依赖即列入问题清单（有对应单测）。Proxy 从
  "运行时兜底"降级为"开发期检漏"，避免生产环境为兜底付出正确性和性能双重代价。

### 顺序敏感语义如何保持

拓扑排序用 Kahn 算法 + 注册顺序号做同层 tie-break。可证明：当依赖图无"回边"
（读者先于写者注册）时，该拓扑序与原 Map 插入序**完全一致**（有单测断言两者逐一相等）。
被跳过的函数其输入字段未变、输出必然相同，因此增量结果与全量结果逐位相等
（等价性单测：600 个输出快照 diff 为空）。

### 兼容性硬约束

- **StrictMode 双调用**：重算只在 effect/事件层驱动，render 纯读快照；`applyInputs`
  对相同值幂等（`Object.is` 比对），双挂载 effect 推入相同输入时执行数为 0，
  ctx 中累加型字段不会翻倍（有单测）。
- **HMR**：`runtime.ts` 的 `import.meta.hot.dispose` 中销毁旧运行时并
  `engine.invalidateAll()`——缓存与 DAG 计算结果整体失效，下一批全量重算（有单测）。
- **动态增删**：`register`/`unregister` 增量维护邻接表并重建拓扑序；注册时做环检测
  （Kahn 排序后若有剩余入度即成环），成环则回滚全部变更并抛 `CycleError`（有单测）。
- **过期批次**：每次输入 bump 版本号，微任务合批只执行最新版本；执行期间若版本号
  再变（如业务函数重入 `pushInput`），本批结果丢弃不提交（有单测）。

## 运行验证

```bash
npm ci            # 安装 lock 中已有依赖（无新增）
npm test          # 20 个单测（Node 24 内置 node:test，零新依赖）
npm run bench     # 基准：优化前基线 vs 优化后对比报告
npm run dev       # 打开页面实操：输入框按键，观察"最近批次 N 个函数重算"
npm run build     # tsc -b && vite build
```

基准实测（本机）：优化前 600 个函数 / 阻塞 ~244ms；优化后 62 个函数 / 阻塞 ~25ms。
断言：重算函数数 < 100、单次阻塞 < 50ms。

## 测试框架说明

仓库无测试框架，按约定请示后采用 **Node 24 内置 `node:test`**（`node --test` 原生
运行 TS，断言用 `node:assert`），未引入任何新依赖。测试位于 `tests/`（在
`tsconfig.app.json` 的 `include: ["src"]` 之外，不参与应用构建）。

汇总区 render 计数断言说明：在不引入 jsdom/测试渲染器的前提下，render 计数在
**订阅边界**断言——测试复刻 `useSyncExternalStore` 的语义（通知 → 取快照 → 引用
比较 → 计数），而组件使用的正是同一个 `store.subscribe` + `getSelection`，因此
"快照引用不变 ⇒ React 不 re-render"由 React 自身保证。组件侧的 smoke 验证可通过
`npm run dev` 打开页面观察。
