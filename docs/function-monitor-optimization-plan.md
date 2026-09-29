# 函数执行监控面板 — 性能优化方案设计

> 日期:2026-09-30 · 仓库:project08/run1a · 范围:代码理解与方案设计(不含实现代码)

## Part 1 现状勘察

### 确切版本(以 package-lock.json 安装结果为准)

| 依赖 | 版本 |
|---|---|
| react / react-dom | 19.3.0 |
| vite | 8.3.1 |
| @vitejs/plugin-react | 6.1.1 |
| typescript | 6.0.3 |
| eslint-plugin-react-hooks | 7.1.1 |

### 场景存在性声明

`src/App.tsx` 当前是 Vite 官方模板的计数器页面,**不存在**"600+ 函数注册表 / 共享可变 ctx / 输入框触发全量重算"的任何代码。本文 Part 2–4 是针对假设场景的设计推演,非对现有代码的诊断。

### React 19.3 原生能力(与本问题相关)

- **稳定 API**:`useTransition` / `startTransition`(可中断的低优先级渲染)、`useDeferredValue`(延迟派生值)、`useMemo` / `memo` / `useCallback`(手工缓存)、`useSyncExternalStore`(外置计算结果订阅)、`StrictMode` 开发期双调用(`src/main.tsx` 已启用)。
- **实验性 / 非稳定**:`use()` 配合 Suspense 的异步边界对本场景(纯同步 CPU 密集)无直接帮助;无官方"可中断同步函数执行"API。
- **需编译器插件**:React Compiler(`babel-plugin-react-compiler`,自动 memo 化)。当前 `vite.config.ts` 未启用,`package.json` 也未安装该插件。

### 当前会整体重渲染的结构

`App` 是单组件无拆分,`count` state 更新时整个 JSX 树(hero 图、链接列表)全部重新执行 render 函数——无 `memo` 边界,React 会 reconcile 全树;只是当前树极小所以无感。`main.tsx` 的 `StrictMode` 意味着开发期每次 render 被调用两次。

## Part 2 执行链路推演

一次按键的完整链路:

1. **事件**:keydown → 浏览器派发 `input`/`onChange`,合成事件回调里调用 `setState`。
2. **调度**:默认优先级(离散事件为同步/Discrete 车道)。React 将更新放入队列,调度一次渲染。若包在 `startTransition` 里则进入 Transition 车道,可被打断。
3. **render 阶段**:React 调用 `App` 函数组件 → 组件体内同步遍历 Map 执行 600+ 个函数、顺序写入共享 ctx。**600 个函数的阻塞就发生在这一环,且是在单个宏任务内连续执行**。
4. **commit 阶段**:diff 出 DOM 变更 → 同步修改 DOM → 触发 `useEffect` 调度。
5. **浏览器渲染流水线**:style → layout → paint → composite,一帧预算约 16ms,前面已耗掉 300ms+,掉帧。

### 为什么时间切片救不了

React 并发特性(时间切片)的打断粒度是**组件级**——render 一个组件完成后,调度器才能检查"是否该让出主线程"。600 个函数如果都在 `App` 这一个组件的函数体内顺序执行,它们是**一个不可中断的同步执行单元**,构成一个 >200ms 的 Long Task,React 无法在函数 300 与 301 之间插入让出点。

时间切片要生效,必须满足:计算被拆散到**多个组件的 render** 中(React 才能在组件间 yield),或者计算本身被移出 render(放进 `useEffect` 分片、Web Worker、`scheduler.yield` 手动切片)。换句话说:**时间切片切片的是 React 的渲染工作,不是你组件体内的普通 JS 循环**。

## Part 3 优化方案

### 方案 A:输入与计算解耦 —— `useDeferredValue` / `startTransition` + 汇总区 memo 化

- **核心思路**:输入框受控值即时更新(高优先级),600 函数的执行结果作为延迟派生值在低优先级渲染中计算;汇总区组件 `memo` 化,只订阅它依赖的 40 个结果。
- **改造面**:输入 state 与"触发重算的快照值"分离;汇总区拆为独立组件;计算逻辑包 `useMemo`(依赖快照值)。
- **硬约束保持**:计算仍在同一次 render 内按 Map 插入顺序同步执行、共享同一 ctx 对象,语义完全不变——只是触发时机从"每次按键"变为"每次去抖后的快照"。
- **失效边界**:StrictMode 双调用会让 600 函数在开发期跑两遍(需保证函数对 ctx 的写入幂等或每次重建 ctx);HMR 替换组件时 Map 若定义在模块外会保留旧函数;若用户连续输入,延迟渲染可能反复被中断重算,极端情况下总耗时反而增加。
- **验证**:INP(web-vitals 库或 DevTools Performance 面板 Interaction 轨)目标 <200ms;Long Task 数量(PerformanceObserver `longtask`);输入延迟用按键到字符上屏的帧时间戳差。

### 方案 B:计算移出 render —— 状态机式执行器(useEffect + 分片 / scheduler.yield)

- **核心思路**:render 不再执行函数;输入变更只记录"输入版本号",由 `useEffect` 中的执行器消费,按 Map 顺序执行并把结果写入 ref/state;执行器内部每 N 个函数 `await scheduler.yield()` 一次,把 600 个函数切成多个 <50ms 的宏任务。
- **改造面**:新增执行器模块(约一个自定义 hook);汇总区改为订阅执行结果 state;需处理"结果未就绪"的中间态 UI。
- **硬约束保持**:执行器持有唯一的可变 ctx,严格按 Map 顺序执行;切片点之间不允许新的执行批次插入(用版本号/取消令牌丢弃过期批次,过期批次要么整体回滚 ctx,要么每次批次从干净 ctx 重放)。
- **失效边界**:这是四个方案中对"共享可变 ctx"风险最高的——**中途取消的批次会留下写了一半的 ctx**,必须规定 ctx 生命周期(每批次新建或快照恢复);StrictMode 下 effect 挂载-卸载-重挂载会触发取消逻辑,需验证不残留脏 ctx;函数总量变化(Map 动态增删)要求执行器以 Map 引用为依赖。
- **验证**:Long Task 应消失(每个分片 <50ms);INP 显著下降;输入延迟 = 一帧内;额外指标"结果就绪延迟"(按键到汇总区更新)需单独监控,它会上升,需产品确认可接受。

### 方案 C:计算移出主线程 —— Web Worker

- **核心思路**:600 函数 + ctx 整体放进 Worker;主线程 render 零计算,输入变更 postMessage 给 Worker,Worker 算完回传 40 个汇总所需结果。
- **改造面**:函数注册表需可序列化地组织进 Worker 模块(Vite 原生支持 `new Worker(new URL(...), { type: 'module' })`);汇总区订阅 Worker 结果;主线程只保留输入与展示。
- **硬约束保持**:Worker 内依然是单线程、顺序执行、共享同一可变 ctx,约束天然满足;且 Worker 不可被主线程打断,顺序性反而更强。
- **失效边界**:**函数若闭包引用了主线程对象(DOM、React state)则无法迁移**——这是最大前置条件;ctx 若含不可结构化克隆的值(函数、DOM 节点)需改造;HMR 下 Worker 需随模块热替换重启,在途批次作废;函数总量变化需重新打包进 Worker 注册表。
- **验证**:主线程 Long Task 归零;INP 与输入延迟只反映输入框自身渲染;新增指标"Worker 往返延迟"(postMessage 到结果回传)。

### 方案 D(对照项):React Compiler 自动 memo 化

- **核心思路**:安装 `babel-plugin-react-compiler`,在 `vite.config.ts` 的 `react()` 插件 babel 选项中注入该插件,编译期自动给组件和 hook 加缓存,等价于自动版方案 A 的 memo 部分。
- **适用性对比**:**React Compiler 解决不了本场景的核心矛盾**。它缓存的是"相同输入的渲染输出",而本场景每次按键输入都变,缓存必然 miss,600 函数照样全量执行;且 Compiler 的 memo 语义假设 render 纯净,**共享可变 ctx + 顺序写入是副作用式代码,违反 Compiler 的纯净性假设**,可能产生缓存脏结果或被 eslint-plugin-react-hooks 7.x 的规则直接报错。手工 `useMemo` 的价值也不在于"记住这 600 次调用",而在于**把计算绑定到去抖后的快照输入上**(方案 A 的精髓是触发时机,不是缓存命中率)。
- **结论**:Compiler 可作为辅助(自动 memo 汇总区等展示组件),但主优化必须来自 A/B/C 之一的结构性改造。
- **Vite 下启用方式**:安装 `babel-plugin-react-compiler` 后,在 `vite.config.ts` 中给 `@vitejs/plugin-react` 传入 babel plugins 配置即可;eslint-plugin-react-hooks 7.x 已内置 Compiler 相关 lint 规则,无需额外插件。

### 推荐

**方案 A 为第一步,方案 C 为终态。** A 改造面最小、不触碰 ctx 语义,大概率把 INP 拉回合格线;若 600 函数单次全量执行本身 >200ms(即使只算一次也构成长任务),则必须上 C 把计算彻底移出主线程,B 作为无法进 Worker 时的折中。

## Part 4 风险清单

| 风险 | 触发条件 | 自测用例意图与断言 |
|---|---|---|
| 缓存脏结果 | `useMemo` 依赖遗漏(如漏掉 ctx 的某个输入源) | 意图:变更任一输入源后重渲染;断言:汇总区数值与全新手工重算结果一致 |
| 闭包捕获旧 ctx | 函数在 Map 注册时闭包引用了上一渲染的 ctx | 意图:连续两次不同输入触发计算;断言:第二次计算读到的是第一次写入的 ctx 值,而非初始值 |
| memo 边界失效 | 汇总区 `memo` 因 props 每次新建对象而穿透 | 意图:按键后渲染;断言:汇总区子组件 render 计数为 0(输入未变快照时) |
| StrictMode 双调用污染 ctx | 开发期 render 双执行,函数重复写入 | 意图:开发模式渲染一次;断言:ctx 终态与单次执行等价(写入幂等或 ctx 每次重建) |
| 过期批次覆盖新结果(方案 B/C) | 快速连续输入,旧批次结果后到达 | 意图:100ms 内连发 5 次输入;断言:汇总区最终展示第 5 次输入对应结果,无中间旧值闪烁残留 |
| 取消批次留下半写 ctx(方案 B) | 分片执行中途被取消 | 意图:执行到第 300 函数时触发新输入;断言:下一批次从干净 ctx 起步,终态与未取消的全量执行一致 |
| HMR 后 Map 含旧函数 | 编辑函数实现后热更新 | 意图:修改一个函数返回值并保存;断言:汇总区立即反映新实现,无旧结果残留 |
| Map 顺序被意外改变 | 动态增删函数导致插入序变化 | 意图:运行时增删注册函数;断言:执行顺序仍符合依赖拓扑,ctx 终态与基准快照一致 |
| Worker 序列化失败(方案 C) | ctx 含不可克隆值 | 意图:构造含函数/DOM 引用的 ctx 提交计算;断言:失败被显式捕获并上报,而非静默丢结果 |
| 输入延迟回归 | 优化后高优先级渲染仍被阻塞 | 意图:性能追踪下连续输入 20 字符;断言:INP < 200ms,无 >50ms 的输入处理长任务 |

## 补充说明

以上所有方案的前提是先把"600 函数注册表 + ctx"这一场景代码真正落到 `src/` 中——目前仓库里它还不存在。建议落地时同步加入 INP / Long Task 的实测埋点(`web-vitals` + `PerformanceObserver`),用数据在 A→C 之间做最终取舍。
