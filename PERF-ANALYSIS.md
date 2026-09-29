# 函数执行监控面板 — 性能现状分析与优化方案

> 场景假设:`src/App.tsx` 接入"函数执行监控面板"——每次渲染同步执行 600+ 个注册在
> `Map<string, (ctx) => any>` 中的业务函数;函数共享同一个可变 context 对象且执行顺序敏感;
> 输入框每次按键触发全量重算(输入延迟 > 300ms,长任务 > 200ms);汇总区只依赖其中 40 个函数但也全量重算。
>
> 本文档只做代码理解与方案设计,不含实现代码。

---

## Part 1 现状勘察

### 确切版本(以 `package.json` + `package-lock.json` 实际安装为准)

| 依赖 | 版本 |
|---|---|
| react / react-dom | 19.3.0 |
| vite | 8.3.1 |
| @vitejs/plugin-react | 6.1.1(基于 Oxc,非 Babel) |
| typescript | 6.0.3(声明 `~6.0.2`) |
| eslint-plugin-react-hooks | ^7.1.1 |

### 关键结论

**场景中描述的"函数执行监控面板"在当前仓库中不存在。** 当前 `src/App.tsx` 是 Vite 模板默认的
计数器页面,只有一个 `count` state,没有 Map 函数注册表、没有共享 ctx、没有输入框。
以下分析基于"假设接入该场景"进行推演。

### 当前版本原生提供的相关能力

- **React 19.3 稳定 API(直接可用)**
  - `useTransition` / `startTransition`:把更新标记为非紧急,渲染可被打断;
  - `useDeferredValue`:延迟派生值,让输入框先更新;
  - `useMemo` / `useCallback` / `memo`:手工缓存;
  - 并发渲染(`createRoot` 默认开启):render 阶段可中断、可丢弃;
  - StrictMode 开发期双调用(`main.tsx` 已启用)——对"可变共享 ctx"是重大风险源(见 Part 2/4)。
- **实验性 / 非稳定**:`unstable_scheduleCallback` 等 Scheduler API、`<Activity>`——不建议依赖。
- **需编译器插件**:React Compiler(`babel-plugin-react-compiler`)。README 明确写明**本模板未启用
  Compiler**,需手动安装配置;`@vitejs/plugin-react` 6.x 支持通过 `babel.plugins` 传入,但该插件默认
  走 Oxc,Compiler 目前仍需 Babel 通道,会拖慢 dev/build(这也是模板默认不开的原因)。

### 当前结构中 state 更新时的重渲染范围

`App` 是根组件且唯一持有 state(`count`),`setCount` 触发整棵组件树重渲染——当前树很小无所谓;
若按场景把 600 函数执行放在 `App` render 体内,则**每次按键 = 整个 App 子树 + 600 个同步函数全部
重跑**,汇总区(只依赖 40 个函数)也无一幸免,因为没有任何 memo 边界。

---

## Part 2 执行链路推演

### 一次按键的完整链路

1. **事件**:浏览器主线程触发 `keydown` → React 的 `onChange` 合成事件(受控组件),`setState`
   被调用,更新被放入对应 lane(离散输入事件,高优先级)。
2. **调度**:React Scheduler 安排一次渲染任务,高优先级 lane 尽快开始 render。
3. **Render 阶段(阻塞点在这里)**:React 调用 `App()` 函数组件 → 场景中的 600 个业务函数在
   render 体内**同步、顺序、串行**执行,共享可变 ctx,后者读前者的写入。这 600 个函数是一个
   **不可中断的同步执行块**(总耗时 > 200ms),全部跑完后 React 才得到新的 JSX,做
   reconciliation / diff。
4. **Commit 阶段**:diff 出 DOM 变更 → 同步写入 DOM → 触发 layout effects / `useEffect`。
5. **浏览器渲染流水线**:Style → Layout → Paint → Composite。若主线程被占 > 200ms,浏览器连
   "按键回显"都画不出来 → 用户感知输入延迟 > 300ms,Performance 面板出现 Long Task
  (> 50ms 即计入,200ms+ 为严重)。

### 为什么 React 时间切片救不了同步函数执行

React 并发时间切片(`startTransition` 下 render 每 ~5ms 让出一次主线程)的**中断粒度是"组件"**——
React 只能在两个组件的 render 之间让出,**无法中断一个组件 render 体内的普通同步 JS 循环**。
600 个函数写在一个组件 render 里,就是一个原子同步块,切片无从下刀。

### 什么条件下才救得了

- 函数执行被**移出 render**(移到事件回调、effect、或 Worker),render 只消费结果;
- 或把执行拆成**多个可中断单元**(每批函数挂到独立的 `scheduler.postTask` / `setTimeout` 切片里
  手动让出);
- 或配合 `useDeferredValue` / `useTransition`,让"输入回显"走高优先级 lane 先 commit,"重算"作为
  低优先级渲染可被后续按键打断重启(但被打断的是 React 的 render;重算若在 render 体内同步执行,
  一旦开始仍跑到底——所以前提是重算结果来自可丢弃的缓存,或重算本身已移出 render)。

---

## Part 3 优化方案

### 方案 A:依赖图 + 增量重算(推荐核心)

- **核心思路**:600 个函数声明各自对 ctx 字段的读依赖,构建 DAG;输入变化只标记受影响字段为
  dirty,按拓扑序只重算下游;汇总区订阅它依赖的 40 个函数的输出,未变则不重渲染。
- **改造面**:中等偏大。函数注册时增加 `reads` 元数据;执行器从"全量 for 循环"改为"dirty 传播
  调度器";ctx 用 Proxy 或显式版本号追踪写入。
- **硬约束保障**:执行顺序仍按原 Map 顺序的拓扑排序(与现状一致);共享可变 ctx 原样保留,只是
  跳过"输入未影响"的函数——其输入字段未变、输出必然相同,顺序敏感语义不被破坏。
- **失效边界**:
  - 函数有**隐式依赖**(读了未声明字段、依赖外部可变变量)→ 缓存脏结果,最大风险;
  - StrictMode 双调用:render 必须纯,调度器需在 effect/事件层驱动,render 只读快照;
  - HMR:函数注册表重建时缓存必须整体失效;
  - 函数总量动态变化:DAG 需增量重建,注册/注销时失效相关子图。
- **量化验证**:INP(目标从 > 300ms 降到 < 200ms,理想 < 100ms);Long Task 数量与最长时长
  (目标消除 > 200ms 任务);单次按键的"重算函数数"(目标从 600 降到几十)。
  实测:Chrome DevTools Performance 录制按键交互;`web-vitals` 上报 INP;
  Long Animation Frames API 统计。

### 方案 B:重算移出渲染帧(useDeferredValue / startTransition + 结果缓存)

- **核心思路**:输入框用即时 state 保证回显;600 函数的执行挂在延迟值或 transition 后的低优先级
  渲染里,且执行结果按"输入快照"做缓存,相同输入直接命中。
- **改造面**:小。输入 state 拆分(即时值 + deferred 值);执行器包一层"以输入为 key 的缓存";
  汇总区消费缓存结果。
- **硬约束保障**:执行器逻辑一行不改,仍是全量、顺序、共享 ctx——只是**执行时机**被推迟、
  **执行次数**被缓存去重。约束天然满足。
- **失效边界**:
  - 治标不治本——缓存 miss 时那一次仍是 200ms+ 同步阻塞(只是不再阻塞回显,阻塞的是结果区);
  - StrictMode 下 render 双调用会触发两次执行,需把执行放 effect 或用幂等缓存包装;
  - 输入是连续流(滑块/实时校验)时缓存命中率低,退化为原问题;
  - ctx 若被函数外因素(时间、网络)影响,按输入 key 缓存会脏。
- **量化验证**:输入框回显延迟(目标 < 50ms,测量 keydown → 字符上屏);INP 中"结果区更新"子项
  允许 > 200ms 但回显必须快;对比前后 Performance 面板中 Long Task 是否仍阻断输入 lane。

### 方案 C:Web Worker 异步执行

- **核心思路**:600 函数整体搬进 Worker 线程执行,主线程 render 只消费最近一次完成的结果;
  主线程彻底零阻塞。
- **改造面**:大。函数注册表需可序列化地传到 Worker(函数不能 postMessage,需放 Worker bundle);
  ctx 每次执行前结构化克隆传入、执行后克隆回传;UI 增加"计算中"态。
- **硬约束保障**:顺序与共享可变 ctx 语义在 Worker 内原样保留(单线程顺序执行不变);但 ctx 的
  "共享"变成"每轮拷贝"——若 UI 侧有同步读 ctx 的需求,此方案直接出局。
- **失效边界**:
  - 函数若引用 DOM、window、React state → 无法在 Worker 运行,一票否决;
  - ctx 体积大时结构化克隆本身成为新瓶颈(需实测;或改 Transferable / SharedArrayBuffer,
    后者有 COOP/COEP 部署要求);
  - 高频输入导致任务排队,需"只保留最新任务"的丢弃策略;
  - HMR 下 Worker 需随主包一起重建。
- **量化验证**:主线程 Long Task 应清零(无任何 > 50ms 任务);端到端"按键 → 结果更新"延迟
  (允许上升,但回显快即可);Worker 往返耗时单独打点。

### 方案 D(辅助,不单独成案):汇总区精准订阅

无论 A/B/C,汇总区都应从"全量结果对象"改为只订阅 40 个函数的输出(拆组件 + `memo`,或
context selector / 外部 store 细粒度订阅),消除"40 个依赖没变也重渲染"的浪费。正交优化,必做。

### 推荐结论

**A 为主,D 必做,B 作为 A 落地前的快速止血**(B 改动最小,当天可上,先解决"输入卡死"这个最痛的
用户感知;A 解决根因,把单次重算成本也降下来)。C 仅在函数集合可序列化、ctx 可拷贝的前提下作为
A 的替代/补充。

### React Compiler vs 手工 memo/useMemo 在本场景的适用性

- 本场景瓶颈是 **render 体内的 600 次同步函数调用**——这是业务计算,不是组件重渲染。
  React Compiler 优化的是"组件/hook 级别的自动 memo",它**不会、也不能**把 render 里的命令式循环
  变成增量计算;对 Map 里动态取出的函数、可变共享 ctx 这种高度命令式、逃逸分析无法证明纯度的代码,
  Compiler 大概率直接放弃优化(bailout)。
- 手工 `useMemo` / `memo` 的价值仅限于方案 D(汇总区组件边界)和方案 B(按输入 key 缓存执行结果)
  这种**粗粒度、语义明确的缓存点**——这些点用 Compiler 自动推导反而不可靠(依赖是动态 Map 内容,
  不是静态可分析的 props/state)。
- **结论**:本场景 Compiler 不是答案,手工缓存在少数明确边界上使用即可。Compiler 可作为项目级
  长期收益另行评估,但不要指望它解决 600 函数问题。
- **Vite 工程下启用 Compiler 的方式**(供参考):安装 `babel-plugin-react-compiler`(对应 react 19
  的版本),在 `vite.config.ts` 的 `react()` 插件中通过 `babel: { plugins: [...] }` 传入
  (plugin-react 6.x 走 Oxc 但保留 Babel 通道给此类插件);注意 dev 冷启动与 build 会变慢,
  模板 README 也提示了这一点。

---

## Part 4 风险清单

| # | 回归风险 | 触发条件 | 自测用例意图(断言描述,不含代码) |
|---|---|---|---|
| 1 | 缓存脏结果(方案 A/B) | 函数隐式读取未声明的 ctx 字段或外部变量,dirty 传播漏标 | 构造"函数 B 隐式依赖字段 X 但未声明"的用例;断言:修改 X 的输入后,B 的输出必须更新(否则说明依赖声明机制有漏检,需配合 Proxy 读追踪兜底) |
| 2 | 闭包捕获旧 ctx(方案 A/B) | 函数注册时闭包捕获旧 ctx 引用,而执行器换了新 ctx 对象 | 连续两轮不同输入执行;断言:第二轮所有函数读到的都是同一最新 ctx 对象(用标记字段验证),且跨轮无旧引用残留 |
| 3 | memo 失效/击穿(方案 B/D) | 输入 key 序列化不稳定(对象 key 顺序、浮点)导致缓存永不命中 | 相同语义输入重复触发 N 次;断言:执行器实际执行次数为 1,其余全部命中缓存 |
| 4 | StrictMode 双调用副作用 | render 体内直接执行函数,开发环境被执行两次,ctx 被写两遍 | 开发模式 StrictMode 下单次输入;断言:ctx 中"计数器/累加型"字段的值与单次执行结果一致(若翻倍即说明副作用在 render 中泄漏) |
| 5 | HMR 后缓存与代码不一致 | 热更新替换了函数实现,但缓存 key 未变,返回旧逻辑结果 | 修改某函数实现触发 HMR;断言:下一次执行结果反映新实现,且注册表大小与预期一致(无重复注册) |
| 6 | 函数总量动态变化破坏 DAG(方案 A) | 运行时注册/注销函数,拓扑序与 dirty 子图过期 | 执行中动态增删函数;断言:新函数被纳入执行序列且顺序正确,被删函数的下游被正确重算,无残留引用报错 |
| 7 | 顺序敏感语义被优化破坏 | 增量重算跳过的函数原本有"写入副作用被更下游读取" | 构造 A 写字段、C 读该字段、中间 B 被跳过的链;断言:跳过 B 后 C 的结果与全量执行完全一致(等价性快照对比:优化前后 600 个输出全量 diff 为空) |
| 8 | Worker 克隆瓶颈/不可序列化(方案 C) | ctx 含函数、DOM 引用、循环引用,或体积过大 | 以生产真实 ctx 跑序列化;断言:结构化克隆不抛错且往返耗时 < 可接受阈值(如 16ms),超限则否决方案 C |
| 9 | 汇总区过度渲染残留(方案 D) | 订阅粒度仍过粗,40 个依赖之外的变化触发汇总区 render | 修改只影响非订阅函数的输入;断言:汇总区组件 render 计数为 0(用 Profiler 或 render 计数器验证) |
| 10 | 指标回退无监控 | 优化上线后无人验证,缓慢退化 | 模拟连续按键的 E2E/合成监控;断言:INP p75 < 200ms、无 > 200ms Long Task、回显延迟 < 50ms,纳入 CI 性能预算 |

### 验证方法统一说明

- INP:用 `web-vitals` 库上报;
- Long Task / LoAF:用 Performance Observer(`longtask`、`long-animation-frame`);
- 输入回显延迟:Performance 面板录制 keydown → paint 区间;
- 函数级耗时:执行器内 `performance.now()` 打点;
- 所有指标应在"优化前基线 vs 优化后"同机同数据对比。
