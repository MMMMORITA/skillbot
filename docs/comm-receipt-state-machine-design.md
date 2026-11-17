# Comm 执行回执与单一状态机（脱离仓库可独立阅读版）

> 本文脱离代码仓库也能读懂。出现的英文名（如 `ExecutionCoordinator`、`WorkflowStateMachine`、`request_id`、`materialized`）是代码里的真实符号，保留是为了答辩对齐术语，每个都配了中文解释。「在 xxx.py / xxx.ts 中」只表明逻辑位置，正文已把逻辑讲清。文中的代码/枚举/表格是为了精确呈现字段与状态，不需要打开仓库也能顺着中文说明读懂。
>
> 状态：本设计的 P0.1–P1.2 已在代码中落地并通过真实 JupyterLab 验证（见文末「实施状态」）。设计日期 2026-09-08。
>
> 范围：JupyterLab 里「Agent 生成代码单元格 → 执行 → 反馈」这条闭环，以及 Agent 工作流的状态管理。
> 不在范围：子 Agent（Sub-agent）、Skill 的输入输出契约、DAG（有向无环图）编排。

## 1. 一句话结论：解决的两个真问题

**问题一：后端“发出去就失联”。** 后端通过 Comm（Jupyter 内核与前端之间的双向消息通道）在 Notebook 里创建一个代码单元格后，**只能拿回一个 `cell_id`（单元格 ID）**，无法知道这个单元格到底有没有开始跑、跑成功了没、失败原因是什么、有没有超时。等于“把代码扔过去就再也听不到回音”。

**问题二：状态有多个“真相源”。** 中枢对象 `AgentMagic`（Notebook 侧的 Agent 调度中枢）同时维护 `_state`（状态枚举）、`_busy`（忙碌布尔标志）、`_auto_pending`（待自动执行计数）和好几个集合，状态变更散落在各业务函数里直接赋值，导致**同一件事有好几个地方在记录**，容易互相矛盾。代码里当时甚至留着注释 `self._busy = False  # legacy — will be removed after refactor`（遗留字段，重构后删除）。

**目标方案（一条流水线）**：

```text
后端生成一个「带版本号的执行请求」
→ 前端在「指定的 Notebook / 指定的内核」上创建或替换单元格
→ 前端沿途回传回执：materialized（已落地）/ started（已开始）/ succeeded（成功）/ failed（失败）
→ 后端 ExecutionCoordinator（执行协调器）幂等地把这些回执聚合成一个 batch（批次）
→ WorkflowStateMachine（工作流状态机）通过唯一的 transition(event)（状态迁移方法）改变工作流状态
→ UI 显示、Notebook 延迟切换、自动修复，全都消费这同一个状态
```

**几个核心决策（答辩要点）**：

- **不同步等待单元格执行完**——否则会卡死内核（因为下一个单元格还得靠同一个内核跑）。
- 前端的 `NotebookActions.executed`（JupyterLab 提供的“单元格已执行完”信号）是执行生命周期结果的**权威来源**。
- Python 的 `post_run_cell`（IPython 在每个单元格运行后触发的钩子）**只**负责保留输出、拍快照、采集遥测；**不再**去递减计数或结束工作流。
- **删掉 `_busy`**：不再维护布尔状态副本。
- **删掉 `_auto_pending`**：待执行数量从 `ExecutionBatch`（执行批次对象）派生出来，而不是单独记一个计数。
- 前端面板也**删掉自己那份 `_busy`**，改为缓存后端下发的 `WorkflowStateSnapshot`（工作流状态快照），交互能力都从快照派生。
- 前端只保留**一套** `skillbot:execute-cell` 的 target（Comm 目标名，可理解为“这条消息管道的频道名”）。
- 每个请求都携带 `request_id`（请求 ID）、`batch_id`（批次 ID）、`notebook_path`（目标 Notebook 路径）和 `kernel_id`（目标内核 ID），**严禁悄悄往“当前焦点 Notebook”乱写**。
- 自动执行的多单元格批次，默认**串行 + fail-fast（一失败就停）**，保证 Notebook 里单元格之间的数据依赖顺序。

## 2. 改造前的现状与痛点

### 2.1 旧 Comm 只回一个 cell_id

旧链路是：渲染输出 → 渲染代码 → 通过 Comm 发单元格 → 创建 `skillbot:execute-cell` 频道。旧请求体只有 `code`（代码）、`auto`（是否自动执行）、`cell_type`（单元格类型）、`replace_cell_id`（要替换的单元格 ID）四个字段；前端创建/替换完单元格后，立刻只回一个 `{"cell_id": "..."}`。后端回调也只做 `on_cell_id(cell_id, code)`。**这只能证明“单元格建出来了”，证明不了“它成功跑完了”。**

### 2.2 旧的“执行完成”是靠猜的

旧代码判断“这是不是一个 Agent 生成的单元格”，靠的是**在代码里搜一句注释** `# %%agent generate code`；命中就把 `_auto_pending`（待执行计数）减一，减到 0 就认为这轮 Agent 任务结束了。这套“靠注释关联”的做法漏洞很多：

- **注释不是稳定协议**：用户手一抖复制了带这行注释的代码，就会被误当成 Agent 单元格。
- **没有请求 ID**：分不清这是哪个批次的执行。
- **迟到的执行**可能去减到了新批次的计数。
- **重复执行同一个单元格**会重复减计数。
- **切换了 Notebook 或重启了内核**后，根本无法证明这条回执属于哪个上下文。
- **前端创建失败时**，`_auto_pending` 永远归不了零，任务卡死。
- **前端执行 Promise 失败时**，后端完全看不见。

### 2.3 前端有两套重复实现

当时前端存在两处几乎重复的单元格 Comm 处理逻辑（一处在 `comm.ts`，一处在 `panel.ts` 里），而且 `panel.ts` 在连接内核时注册一次频道、插件注册时又注册一次同名频道。后果是：**后注册的可能覆盖先注册的**；只改一处会导致行为漂移；内核重启/Notebook 切换时“到底注册了几次”不透明；也没法为执行回执建立单一的测试入口。

### 2.4 旧状态管理的问题

旧的状态枚举 `AgentState` 有 `IDLE`（空闲）、`STREAMING`（流式生成）、`PLAN_REVIEW`（计划审阅）、`WAITING_CONFIRM`（等待确认）、`AUTO_FIXING`（自动修复）几个值，同时还并存着 `_busy`、`_auto_pending`、`_agent_cells`、`_round_results`、`_pending_result`、`_pending_session_nb_path` 一堆字段。真正的问题**不只是字段重复，而是没有统一的“合法迁移校验”**：

- `WAITING_CONFIRM` 和 `PLAN_REVIEW` 都是 `_busy=False`，但都不能接受新指令——布尔标志表达不了这种细分。
- `STREAMING` 既表示“模型正在生成”，又表示“正在等单元格执行”，一词多义。
- `AUTO_FIXING` 完成后直接回到 `STREAMING`，表达不了“原批次是否还有单元格没跑”。
- 结束任务的函数可以从多个地方触发，只能靠“判断是不是已经 IDLE 了”来避免重复结束。

## 3. 目标与非目标

### 3.1 目标

1. 后端能**准确知道**每个请求是否已创建、开始、成功、失败、被拒、被取消、超时。
2. 每个执行事件都能**关联到**具体的请求、批次、Notebook、内核和单元格。
3. **重复、乱序、迟到**的回执不会破坏当前任务。
4. 自动执行多个单元格时，**顺序确定**。
5. 工作流状态**只有一个权威状态机**。
6. Notebook 切换、内核重启、用户停止、自动修复，都有**明确语义**。
7. 单元测试和真实 Jupyter 端到端（E2E）测试**都能验证闭环**。
8. 改造可**分阶段灰度**，出问题能回退旧路径。

### 3.2 非目标

明确不在本设计里做：并行子 Agent、Skill 的输入输出 Schema（数据结构约定）、通用 DAG、多内核并行执行、跨进程持久化恢复未完成批次、把完整单元格输出塞进 Comm 消息、给任意“用户手工执行的单元格”也建工作流、改造 Agent 模型的输出协议。

## 4. 五条设计原则

1. **不阻塞内核**：后端发出请求后立即返回，不能在发送处等待 Promise、轮询文件或阻塞事件——因为前端触发的下一个单元格还得用同一个内核执行，一等就自锁。
2. **事件驱动**：所有“完成 / 失败 / 中断 / 超时”都转成事件，交给协调器和状态机处理。
3. **状态单一来源**：工作流阶段只存在 `WorkflowStateMachine.state`（状态机的状态字段）里。“UI 是否就绪”“能否收新指令”“要不要延迟切 Notebook”全从它派生。
4. **身份优先于焦点**：不能用“当前正打开的那个窗口”当唯一目标依据（`tracker.currentWidget` 指“当前焦点窗口”）——用户可能在请求到达前切了标签页。请求必须**声明目标 Notebook 和内核**，前端匹配上了才写入。
5. **幂等优先**：回执可能重复、乱序、延迟。协调器按 `request_id + phase`（请求 ID + 相位）去重，**终态不会被普通的迟到事件覆盖**。

还有一条重要的分工原则——**执行结果 与 输出采集分离**：前端回执回答的是“执行生命周期成不成功”，用来驱动工作流；`post_run_cell` 钩子回答的是“这次执行的代码、输出、错误详情具体是什么”，用来做上下文、快照和遥测。**两者不能同时去改批次计数**，否则又回到多真相源。

## 5. 目标架构（自上而下一条线）

从上到下的组件链是这样的（都在 Notebook 内核进程里，除了最下面的前端）：

- **`AgentMagic`（调度中枢）**：接收用户指令 / 计划 / 确认 / 停止。
- **`WorkflowStateMachine`（工作流状态机）**：持有 `state`（状态）+ `transition(event)`（迁移方法）+ 派生能力（如“能否接新指令”）。它产出的是 **effect（副作用指令）**，而不是自己去做 I/O。
- **`ExecutionCoordinator`（执行协调器）**：管 batch（批次）、request 登记表、超时、幂等。
- **`CellCommClient`（Python 侧 Comm 客户端）**：负责“带版本号的请求”和 Comm 生命周期。

往下通过 `skillbot:execute-cell` 这条频道，到达前端：

- **前端执行插件（JupyterLab 扩展）**：定位 Notebook/内核 → materialize（落地单元格）→ run（运行）→ 回执。
- 它监听 JupyterLab 的 `NotebookActions.executionScheduled`（已排期执行）/ `executed`（已执行完）两个信号。

回执再沿原路返回：`ExecutionCoordinator` 收到后调用 `WorkflowStateMachine.transition()` 推进状态。

**另一条并行支线**：Python 的 `post_run_cell` 钩子只做“命名空间更新 + 输出 + 快照 + 遥测”，不碰工作流状态。

## 6. 数据模型（脱离仓库要能看懂字段含义）

### 6.1 执行请求 CellExecutionRequest

这是后端发给前端的“工单”，是一个不可变（frozen，创建后不能改）的数据类。关键字段与含义：

- `protocol_version`（协议版本）：初版固定为 `1`，用来做新旧协议区分。
- `request_id`（请求 ID）：每个单元格唯一，用 UUID（全局唯一标识）。
- `batch_id`（批次 ID）：同一轮生成的多个单元格**共用**一个。
- `notebook_path`（目标 Notebook 路径）：必须非空。
- `kernel_id`（目标内核 ID）：必须是发送时绑定的那个内核。
- `operation`（操作类型）：三选一——`create`（新建单元格）/ `replace`（替换某个已有单元格）/ `run_existing`（运行某个已有单元格）。
- `code`（代码文本）、`cell_type`（`code` 或 `markdown`）、`auto_execute`（是否自动执行）。
- `replace_cell_id` / `run_cell_id`：分别在 `replace` / `run_existing` 时必填。
- `sequence_index` / `sequence_size`（本单元格在批次里的序号 / 批次总数），`timeout_ms`（超时毫秒，默认 600000 即 10 分钟）。

约束里最关键的是**身份获取规则**：

- `notebook_path` 用前端已经写入的权威路径（前端在 Notebook 激活时通过 `_set_active_notebook_path()` 告诉后端当前是哪个 Notebook）。
- `kernel_id` 从 ipykernel 的连接文件名里提取——连接文件名形如 `kernel-<kernel_id>.json`，去掉前缀 `kernel-` 就是内核 ID。逻辑封装在 `current_kernel_id()`（在 `cell_execution.py` 中）：读取连接文件的文件名主干，若不以 `kernel-` 开头就直接报错。
- **Python 拿不到内核 ID 时，v1 的自动执行请求必须明确失败**，**绝不允许**把内核 ID 留空然后降级写到“当前焦点 Notebook”——这正是原则四“身份优先于焦点”的落地。
- 单次 `code` 仍受 100 KB 上限保护。

### 6.2 执行回执 CellExecutionReceipt 与相位

前端沿途回传的“进度条”，核心是一个**相位枚举** `ReceiptPhase`（回执相位），按时间顺序是：

- `received`（已收到请求）→ `materialized`（单元格已落地到 Notebook）→ `started`（已开始执行）→ `succeeded`（成功）/ `failed`（失败）。
- 另有两个非正常路径的终态：`rejected`（被拒绝，见 7.4）、`cancelled`（被取消）。

回执体除了相位，还带 `request_id`、`batch_id`、`notebook_path`、`kernel_id`、`timestamp_ms`（前端事件发生的时间戳），以及可选的 `cell_id`、`execution_count`（执行计数，就是 Notebook 单元格左侧 `[12]` 那个数字）、`elapsed_ms`（耗时）、`error_code`（错误码）、`error_message`（错误文本）。

还有一个特殊的本地相位 **`timed_out`（超时）**：它**不需要前端回传**——因为“超时”本身就意味着“回执缺失”，所以由协调器在本地生成。

### 6.3 请求状态 与 终态定义

协调器为每个请求维护一个状态机 `CellRequestState`：`QUEUED`（排队）→ `SENT`（已发送）→ `RECEIVED` → `MATERIALIZED` → `STARTED` → `SUCCEEDED`，以及分支上的 `FAILED` / `REJECTED` / `CANCELLED` / `TIMED_OUT`。

**终态定义要分两种情况**（这是个容易搞混的点）：

- **非自动执行，或 Markdown 单元格**：`MATERIALIZED`（落地）本身就是终态——因为它根本不需要“执行成功”。
- **自动执行的代码单元格**：`MATERIALIZED` **不是**终态，必须走到 `SUCCEEDED` / `FAILED` / `REJECTED` / `CANCELLED` / `TIMED_OUT` 之一才算完。

### 6.4 执行批次 ExecutionBatch

一个批次聚合同一轮生成的多个请求，字段有 `batch_id`、`notebook_path`、`kernel_id`、`requests`（请求列表）、`fail_fast`（是否一失败就停，默认 True）、创建/结束时间戳。它对外暴露的是**派生属性**：`pending_count`（还没结束的请求数）、`terminal_count`（已进终态数）、`failed_count`（失败数）、`next_queued`（下一个待发的请求）、`is_terminal`（整批是否结束）、`is_success`（整批是否成功）。**关键纪律：待执行数量从这里派生，禁止再单独维护 `_auto_pending`。**

## 7. Comm 协议（消息长什么样）

### 7.1 正常路径：创建并执行一个单元格

请求里 `action` 为 `execute_cell`，`operation` 为 `create`，`auto_execute` 为 `true`。正常回执序列会依次出现四条：

```text
received（收到）→ materialized（落地，带 cell_id）→ started（开始）→ succeeded（成功，带 execution_count 和 elapsed_ms）
```

### 7.2 只创建、不执行

当 `auto_execute=false` 或 `cell_type=markdown` 时，序列只走到 `received → materialized`，`materialized` 即终态。典型场景：Agent 只想往 Notebook 里插一个 Markdown 计划单元格，或者只想生成代码给用户看、不自动跑。

### 7.3 失败回执

失败时相位为 `failed`，带上 `error_code`（如 `CELL_EXECUTION_ERROR`）和 `error_message`（如 `NameError: name 'load_data' is not defined`）。**错误文本上限建议 2000 字符**，不通过 Comm 发送完整的 traceback（异常调用栈）或整个单元格输出——避免消息过大、也避免泄露过多内容。

### 7.4 拒绝回执：宁可明确报错，也不静默返回

以下情况**必须**回 `rejected`，绝不能悄悄 `return` 让后端傻等：Notebook 不存在、Notebook 路径不匹配、内核不存在、内核 ID 不匹配、要替换/运行的单元格 ID 找不到、单元格类型非法、协议版本不支持、请求字段缺失、单元格控件在重试窗口内没出现。对应的标准错误码有一套固定命名，便于排查：`UNSUPPORTED_PROTOCOL`（协议不支持）、`INVALID_REQUEST`（请求非法）、`NOTEBOOK_NOT_FOUND` / `NOTEBOOK_MISMATCH`（Notebook 找不到 / 不匹配）、`KERNEL_NOT_FOUND` / `KERNEL_MISMATCH`（内核找不到 / 不匹配）、`CELL_NOT_FOUND`（单元格找不到）、`CELL_WIDGET_TIMEOUT`（单元格控件超时）、`CELL_EXECUTION_ERROR`（执行报错）、`COMM_SEND_ERROR`（Comm 发送失败）。

### 7.5 内核繁忙时的消息时序（一个易踩的坑）

Jupyter 内核在跑一个长单元格时，前端发回来的 Comm 消息可能**在 shell 通道里排队**，直到当前单元格结束或被中断后，Python 才有机会处理。这带来一系列时序问题，处理办法是：

- 每条回执都必须带**前端事件发生时的 `timestamp_ms`**（而不是后端处理时的时间）。
- 前端可以根据本地的 `executionScheduled`/`executed` 信号**即时显示**单元格级状态，但**本地显示不能直接改后端的工作流状态**——本地只是乐观提示。
- 后端恢复处理后，按合法顺序快速消费排队的回执。
- 超时判断要**分别记录“事件时间”和“本地接收时间”**，`delivery_delay_ms = 接收时间 − 事件时间`（投递延迟），避免把“内核忙导致回执延迟”误判成“前端根本没执行”。执行超时用前端的 `started` 时间来判；还没收到 `started` 时用发送时间兜底。
- **停止（Stop）必须保留“前端直接调 `kernel.interrupt()`（中断内核）”**，不能等后端先收到 `/stop`——因为后端处理 `/stop` 本身可能也在排队。

## 8. 前端设计要点

**单一插件**：以 `comm.ts` 为唯一执行实现（导出 `cellExecutionPlugin` 并在 `index.ts` 注册），删掉 `panel.ts` 里那套重复 handler 和两处重复的频道注册。面板（`panel.ts`）从此只处理聊天 Comm，不再持有单元格执行协议。这直接解决了 2.3 的重复实现问题。

**精确定位 Notebook**（原则四的前端落地）：收到请求后，从窗口列表里按 `context.path`（Notebook 文件路径）找到目标 Notebook，读它的会话内核 ID，与请求里的 `kernel_id` 比对，**任一不一致就拒绝**，**禁止回退到当前焦点 Notebook**。

**单元格元数据（metadata）**：创建/替换单元格时，往单元格的 `skillbot` 元数据里写入 `generated`（标记为 Agent 生成）、`protocol_version`、`request_id`、`batch_id`、`sequence_index`。用途是：前端的“已执行”信号能靠它关联回请求；Python 的 `post_run_cell` 能读到 `request_id`；用户重复执行时能判断来源；调试时不用再去解析代码注释。旧的 `# %%agent generate code` 注释在兼容期保留，迁移完成后不再作为身份依据。

**执行监听**：用 JupyterLab 自带的两个信号——`executionScheduled`（命中请求元数据后发 `started`）和 `executed`（命中后发 `succeeded` 或 `failed`）。失败时用 `KernelError`（内核错误对象）的 `errorName/errorValue` 生成有长度上限的错误文本。监听器按 `request_id` 去重。若 `NotebookActions.run()`（运行单元格的 API）返回 `false` 且没有产生 `executed` 信号，就发 `failed` 并带错误码 `CELL_EXECUTION_NOT_STARTED`（执行未启动）。**为什么不只依赖 `run()` 的 Promise**：Promise 只能告诉你整体操作的布尔结果，而 `executed` 信号同时给出了单元格对象和内核错误，配合元数据能稳定关联到请求。

**Comm 生命周期**：每个请求用一个独立的 Comm。后端发请求、前端发回执，**收到终态后由后端关闭 Comm**（这一点是踩坑后修正的，见文末实施状态里的竞态问题）；非自动请求在 `materialized` 后即可关闭；前端出异常时尽量先发 `rejected` 再关闭。后端对活跃 Comm 保持强引用，避免被垃圾回收（GC）误清。

## 9. 后端 Comm 客户端

新增模块 `cell_execution.py`，集中放 `CellExecutionRequest`、`CellExecutionReceipt`、`CellCommClient`、`ExecutionBatch`、`ExecutionCoordinator` 这几个类。

`CellCommClient`（Comm 客户端）对外提供三个方法：`send`（发送请求并注册回执回调 `on_receipt`）、`cancel`（按 `request_id` 取消）、`close_all`（按原因关闭全部活跃 Comm）。它的职责是：序列化请求、维护 `request_id → comm` 映射、解析校验回执、进入终态后关闭并移除 Comm、把 Comm 解析错误转成本地 `REJECTED`、内核切换时关闭全部活跃 Comm。

**兼容 API**：迁移期保留旧的 `send_cell_via_comm(...)` 入口，内部转成新请求；旧的 `on_cell_id` 回调在首次 `materialized` 时调用，保证计划单元格和既有测试不立刻失效。新代码不再新增 `on_cell_id`，改用 `on_receipt` 或直接走协调器。

**渲染集成**：旧的渲染逻辑会在循环里直接一个个建单元格、立刻创建多个 Comm。改造后分成两层——先把每个单元格描述成一个 `CellSpec`（代码 + 类型 + 要替换的 ID），再由 `ExecutionCoordinator.submit_batch(...)` 统一提交成一个批次。计划 Markdown、单元格恢复、单元格优化这些“单个单元格”的路径，也生成“只含一个请求的批次”，走统一通道。

## 10. 执行协调器 ExecutionCoordinator（核心大脑）

**职责**：建批次、给每个单元格建请求、默认串行派发、校验回执身份、执行幂等状态推进、管两类超时、fail-fast、汇总批次结果、向状态机发领域事件。

**串行执行**：自动执行多个单元格时，严格“发第一个 → 等它成功 → 再发第二个 → …… → 全部成功则批次成功”。这么做的理由：Notebook 单元格之间常有变量依赖（第二个用到第一个定义的 `df`）；避免多个 `run()` 同时抢改“当前活动单元格”；某个失败时不会继续跑依赖了错误结果的后续单元格；请求和结果的关联也更简单。非自动模式可以连续把所有单元格都 materialize（落地），但仍按请求顺序等 `materialized`，避免活动索引竞争。

**幂等规则**（应对重复/乱序/迟到）：

- 收到**相同相位重复**的回执：忽略，记一条 debug 遥测。
- 已进终态后又收到**非终态**回执：忽略。
- `SUCCEEDED` 之后又收到 `FAILED`：记为协议违规（protocol violation），**不覆盖成功**。
- `FAILED` 之后又收到 `SUCCEEDED`：记为迟到矛盾（late contradiction），**不自动翻转**。
- 未知 `request_id`：记为孤儿回执（orphan receipt），不影响当前批次。
- `batch_id` 不匹配、Notebook/内核不匹配：拒绝。

**两类超时**：`materialize_timeout`（落地超时，请求发出后迟迟收不到 `materialized`，建议默认 5 秒）和 `execution_timeout`（执行超时，`started` 之后迟迟收不到终态回执，沿用 Agent 默认 600 秒）。超时检查**不能**开一个阻塞线程去等内核，而是用轻量定时器，定时器回调只往协调器投递一个 `REQUEST_TIMED_OUT`（请求超时）事件。

**自动修复流程**：单元格 `failed` 后——① 协调器把当前请求标失败；② fail-fast，把批次里还排队的请求标成 `cancelled`；③ 状态机收到 `CELL_FAILED`；④ 若自动修复次数没超上限，迁移到 `AUTO_FIXING`；⑤ 用失败单元格的代码、有界错误文本、以及 `post_run_cell` 已采集的输出，生成一个修复请求；⑥ 修复代码建**一个新批次**，**不复用旧请求 ID**。已进终态的旧批次禁止再改，便于审计。

## 11. 单一工作流状态机 WorkflowStateMachine

### 11.1 八个状态

`WorkflowState`（工作流状态）枚举一共八个，每个都有明确单一语义：

- `IDLE`（空闲）：唯一能接收新指令的状态。
- `AGENT_STREAMING`（模型流式生成中）：正在生成文本或代码。
- `PLAN_REVIEW`（计划审阅）：计划已呈现，等用户确认或提修改意见。
- `WAITING_CONFIRM`（等待确认）：代码或“继续”动作等用户确认。
- `CELL_DISPATCHING`（派发中）：正在往前端 materialize 单元格。
- `CELL_EXECUTING`（执行中）：至少一个自动执行单元格已 `started`，或批次正等执行终态。
- `AUTO_FIXING`（自动修复中）：正在生成失败单元格的修复。
- `INTERRUPTING`（中断收尾中）：已发停止请求，等待活跃的 Agent/单元格收口。

### 11.2 用“能力属性”替代 _busy

不再用含义模糊的 `_busy`，而是从状态派生几个只读能力属性：`accepts_new_prompt`（能否接新指令，仅 `IDLE` 为真）、`awaiting_user`（是否在等用户，`PLAN_REVIEW`/`WAITING_CONFIRM` 为真）、`has_active_work`（是否有活跃工作，非 `IDLE` 即为真）、`should_defer_notebook_switch`（是否应推迟 Notebook 切换，非 `IDLE` 即为真）。**含义模糊的 `is_busy` 不再参与任何业务判断。**

### 11.3 事件

状态机的输入是 `WorkflowEvent`（工作流事件）枚举，覆盖全生命周期，例如：`USER_PROMPT_ACCEPTED`（用户指令被接受）、`AGENT_RETURNED_PLAN/CODE/TEXT/EMPTY`（模型返回了计划/代码/纯文本/空）、`USER_CONFIRMED/REJECTED`（用户确认/拒绝）、`PLAN_REVISION_REQUESTED`（请求改计划）、`CELL_BATCH_CREATED`（批次已建）、`CELL_MATERIALIZED/STARTED/SUCCEEDED/FAILED/REJECTED/CANCELLED/TIMED_OUT`（单元格各相位事件）、`BATCH_SUCCEEDED`（整批成功）、`AUTO_FIX_RETURNED_CODE/EXHAUSTED`（修复返回代码/次数耗尽）、`STOP_REQUESTED`（请求停止）、`INTERRUPT_COMPLETED`（中断完成）、`INTERNAL_ERROR`（内部错误）。

**特别注意**：Notebook 切换**不是**一个工作流事件、**不改变**工作流状态。它只在 `has_active_work` 为真时把“最后一个待切换路径”存起来，等回到 `IDLE` 再应用（见 12.4）。

### 11.4 核心迁移表（哪些状态遇到哪些事件、去哪、做什么）

下表是状态机的“法律条文”。每行是“当前状态 + 事件 → 下一状态 + 主要副作用”。这也是答辩时讲“状态如何流转”的权威依据：

| 当前状态 | 事件 | 下一状态 | 主要副作用（Effect） |
|---|---|---|---|
| IDLE | USER_PROMPT_ACCEPTED | AGENT_STREAMING | 启动模型流 |
| AGENT_STREAMING | AGENT_RETURNED_PLAN | PLAN_REVIEW | 渲染计划、显示确认 |
| AGENT_STREAMING | AGENT_RETURNED_CODE | WAITING_CONFIRM | 默认模式显示确认 |
| AGENT_STREAMING | CELL_BATCH_CREATED | CELL_DISPATCHING | auto 模式发第一个请求 |
| AGENT_STREAMING | AGENT_RETURNED_TEXT | IDLE | 纯文本回答完成，恢复输入 |
| AGENT_STREAMING | AGENT_RETURNED_EMPTY | IDLE | UI 就绪 |
| PLAN_REVIEW | PLAN_REVISION_REQUESTED | AGENT_STREAMING | 请求模型修订计划 |
| PLAN_REVIEW | USER_CONFIRMED | CELL_DISPATCHING | 已有现成代码时建批次 |
| PLAN_REVIEW | USER_CONFIRMED | AGENT_STREAMING | 无现成代码时先生成实现 |
| PLAN_REVIEW | USER_REJECTED | IDLE | 清理计划 |
| WAITING_CONFIRM | USER_CONFIRMED | CELL_DISPATCHING | 建执行批次 |
| WAITING_CONFIRM | USER_REJECTED | IDLE | 清理待执行结果 |
| CELL_DISPATCHING | CELL_MATERIALIZED | CELL_DISPATCHING | 自动代码等 started；非自动模式发下一个 |
| CELL_DISPATCHING | CELL_STARTED | CELL_EXECUTING | 前端已调度执行 |
| CELL_DISPATCHING | CELL_MATERIALIZED | CELL_DISPATCHING / IDLE | 非自动模式发下一个或完成 |
| CELL_DISPATCHING | CELL_REJECTED | IDLE | 批次失败，展示错误 |
| CELL_DISPATCHING | CELL_TIMED_OUT | IDLE | 落地超时，展示错误 |
| CELL_DISPATCHING | CELL_CANCELLED | IDLE | 停止或内核重启 |
| CELL_EXECUTING | CELL_SUCCEEDED | CELL_DISPATCHING | 批次还有下一个请求 |
| CELL_EXECUTING | BATCH_SUCCEEDED | IDLE | 完成、UI 就绪 |
| CELL_EXECUTING | CELL_FAILED | AUTO_FIXING | 可自动修复 |
| CELL_EXECUTING | CELL_FAILED | IDLE | 不修复或不可修复 |
| CELL_EXECUTING | CELL_TIMED_OUT | IDLE | 执行超时，不猜结果 |
| CELL_EXECUTING | CELL_CANCELLED | IDLE | 中断已确认 |
| AUTO_FIXING | AUTO_FIX_RETURNED_CODE | CELL_DISPATCHING | 新修复批次 |
| AUTO_FIXING | AUTO_FIX_EXHAUSTED | IDLE | 展示失败 |
| 任意非 IDLE | STOP_REQUESTED | INTERRUPTING | 停模型 / 取消排队请求 |
| INTERRUPTING | INTERRUPT_COMPLETED | IDLE | 清理并应用待切换 |
| 任意状态 | INTERNAL_ERROR | IDLE | 记录错误并安全收口 |

### 11.5 非法迁移怎么处理

对于表里没有的“非法迁移”（比如 `IDLE + CELL_SUCCEEDED`、`PLAN_REVIEW + CELL_STARTED`、`WAITING_CONFIRM + BATCH_SUCCEEDED` 这类孤儿事件），`transition()` 的处理是：**不改状态**、记一条 `workflow_transition_rejected`（迁移被拒）遥测；开发/测试模式下抛 `InvalidTransition`（非法迁移异常）好暴露问题，生产模式下返回失败结果并安全提示；**绝不“猜一个状态”自动恢复**。

### 11.6 迁移 API 与快照

`transition(event, payload)` 返回一个 `TransitionResult`（迁移结果），里面含 `previous`（前一状态）、`current`（当前状态）、`effects`（本次要执行的副作用元组）。**它只负责校验、更新状态、生成副作用、记录迁移；真正的 I/O 由 `AgentMagic` 去执行这些副作用**——这样状态机的单测就不依赖 Comm、面板或模型，纯逻辑可测。

状态机还维护一个**单调递增的 `revision`（修订号）**。每次有效迁移都向面板发一个 `WorkflowStateSnapshot`（状态快照），里面含 `state`、`revision`、`active_batch_id`（当前批次）、`completed_cells`/`total_cells`（已完成/总单元格数）、`message`（状态文案）。**前端只接受 `revision` 更大的快照**，从而避免旧的 Comm 消息覆盖新状态；面板 Comm 重连时会主动请求最新快照。

### 11.7 副作用 Effect

状态机产出的副作用 `WorkflowEffect` 是一组“指令枚举”，由 `AgentMagic` 负责真正执行，例如：`START_AGENT_STREAM`（启动模型流）、`SHOW_PLAN_CONFIRM`/`SHOW_CODE_CONFIRM`（显示计划/代码确认）、`CREATE_EXECUTION_BATCH`（建执行批次）、`DISPATCH_NEXT_CELL`（派发下一个单元格）、`START_AUTO_FIX`（启动自动修复）、`CANCEL_ACTIVE_BATCH`（取消当前批次）、`SEND_PANEL_READY`（通知面板就绪）、`APPLY_PENDING_NOTEBOOK_SWITCH`（应用待切换的 Notebook）。

## 12. 四个关键流程

### 12.1 Auto 模式成功（两个单元格）

用户发指令 → 状态机进入 `AGENT_STREAMING` → 模型返回两个单元格 → `CELL_BATCH_CREATED` → 进入 `CELL_DISPATCHING`，协调器**先发第一个请求** → 前端创建单元格回 `materialized` → 收到 `started` 进入 `CELL_EXECUTING` → 内核跑完回 `succeeded` → 回到 `CELL_DISPATCHING` **再发第二个请求** → 第二个也 `succeeded` → `BATCH_SUCCEEDED` → 回到 `IDLE` 并通知面板就绪。整条链路严格串行，第二个一定在第一个成功之后才发。

### 12.2 单元格失败并自动修复

`CELL_EXECUTING` 时第一个请求 `failed` → 取消排队中的第二个请求（fail-fast）→ 进入 `AUTO_FIXING` → 模型生成修复代码 → 新建一个修复批次和新请求 → 回 `CELL_DISPATCHING` → `CELL_EXECUTING` → `succeeded` → `IDLE`。**原批次保持 failed 状态不动**，便于审计“到底哪一步失败了、怎么修的”。

### 12.3 用户停止（Stop）

按当前状态分别处理：`AGENT_STREAMING` 时中断模型流；`CELL_DISPATCHING` 时把排队请求标 `cancelled`，已发但未执行的在前端收到取消时尽力取消；`CELL_EXECUTING` 时**前端立即调 `kernel.interrupt()`**，后端收到中断后取消排队请求，当前请求等 `cancelled/failed` 或本地超时。任意路径最终都收敛到 `INTERRUPTING → IDLE`。

**第一版明确不承诺**能强制撤销“已经进了内核队列的执行”，只保证四件事：不再派发后续单元格、请求状态可观测、终态最终收敛、不把迟到的成功当成新任务结果。**推荐的停止顺序**是：① 前端立刻把本地显示切成 `Stopping`（仅瞬时乐观显示，不改权威状态）；② 前端调 `kernel.interrupt()`；③ 前端发 `/stop` 控制命令；④ 后端处理 `KeyboardInterrupt`（键盘中断）或排队的 stop；⑤ 状态机发布权威的 `INTERRUPTING → IDLE` 快照。之所以前端要先自己中断，是因为内核跑长单元格时后端处理 `/stop` 本身也会排队，来不及响应。

### 12.4 Notebook 切换

逻辑很简单：`IDLE` 时立即切换会话；非 `IDLE` 时只把最新目标路径存进 `pending_notebook_path`。因为执行请求已经绑定了原 Notebook 和内核，前端不会写到新焦点 Notebook。等状态回到 `IDLE` 后：清理当前会话 → 应用最后一个待切换路径（last-path-wins，以最后一次为准）→ 清空待切换 → 新 Notebook 下次发指令时懒加载会话。

### 12.5 内核重启

前端检测到内核 ID 变化后：关闭旧内核下的活跃单元格 Comm；对未终态请求发 `cancelled/KERNEL_RESTARTED`（发送失败就由后端超时兜底）；重新注册唯一的执行频道；后端协调器把旧内核 ID 的批次终止；状态机进入 `IDLE`；**不在新内核上自动重放旧代码**——因为重放会导致重复副作用。

## 13. post_run_cell 钩子的改造

**保留**的职责：更新命名空间（`Namespace.track_cell()`）、丰富 `_round_results` 的输出、拍单元格快照、拍 Notebook 快照、采集 `cell_executed` 遥测、为自动修复提供完整的输出/错误。

**移除**的职责（关键）：不再靠代码注释判断批次成员、不再递减 `_auto_pending`、不再调结束函数、不再直接触发工作流状态迁移。它现在关联请求的方式是：优先从单元格元数据读 `request_id`；用 `info.cell_id` 映射到协调器里已 materialize 的请求；找不到请求就当普通用户单元格处理。这彻底落实了原则六“执行结果与输出采集分离”。

## 14. UI 语义（面板显示从状态派生）

面板的输入框、停止按钮、确认控件、状态文案，**全部从工作流状态派生**，不再由零散调用点自行发送互相矛盾的“就绪”消息。对应关系：`IDLE`（输入可用/停止隐藏/文案 Ready）、`AGENT_STREAMING`（输入禁用/文案 Thinking）、`PLAN_REVIEW`（只允许提反馈/显示确认/文案 Review plan）、`WAITING_CONFIRM`（只允许确认或拒绝/文案 Awaiting confirmation）、`CELL_DISPATCHING`（输入禁用/文案 Creating cells）、`CELL_EXECUTING`（输入禁用/文案 Running cell i/n）、`AUTO_FIXING`（文案 Fixing failed cell）、`INTERRUPTING`（输入和停止都禁用/文案 Stopping）。其中 `SEND_PANEL_READY`（通知就绪）这个副作用**只允许由“进入 IDLE 的那次迁移”产生**，杜绝重复就绪。

**前端状态同步**：面板持有一个 `_workflowState` 快照对象，所有行为都从快照派生（能否接新指令、能否停止、是否在等用户、状态文案）。要求：删掉前端 `_busy` 的业务写入；`text`/`result`/`ready` 这些消息不再隐式切忙闲；`workflow_state` 是唯一权威状态消息；Comm 重连后前端主动发 `get_workflow_state` 请求，后端返回当前快照（**而不是默认认为 Ready**）；指令队列只在“能接新指令”为真时才出队。

## 15. 遥测 Telemetry

新增一批事件：`cell_request_created`（请求已建）、`cell_receipt`（收到回执）、`cell_request_timeout`（请求超时）、`cell_receipt_duplicate`（重复回执）、`cell_receipt_orphan`（孤儿回执）、`cell_receipt_protocol_error`（协议错误回执）、`execution_batch_completed`（批次完成）、`workflow_transition`（状态迁移）、`workflow_transition_rejected`（迁移被拒）。字段含 `request_id`、`batch_id`、`notebook_path_hash`、`kernel_id_prefix`、`cell_id`、`phase`、`state_before`/`state_after`、`elapsed_ms`、`error_code` 等。

**隐私与体积**：遥测不记录完整代码；Notebook 路径默认哈希；内核 ID 可截断；错误文本截断；完整输出仍按既有 `cell_executed` 策略处理。由此可算出一组核心监控指标：落地成功率、执行成功率、落地超时率、执行超时率、孤儿回执率、重复回执率、非法迁移率、批次完成耗时的 P50/P95、内核重启取消率。

## 16. 兼容与分阶段迁移

用一个特性开关 `SKILLBOT_CELL_RECEIPTS`（取值 0/1）控制走旧路径还是新路径：`0` 用旧的 `cell_id + post_run_cell + _auto_pending`；`1` 用新的请求/回执 + 协调器。默认先 `0`，E2E 通过后改 `1`，稳定一个发布周期后删掉旧路径和开关。协议层面，前端对缺少 `protocol_version` 的旧请求按 v0 处理、只回 `{cell_id}`、不进新回执逻辑；后端新路径只发 v1。

整个改造拆成五个独立可测的提交：① 前端执行逻辑去重（`comm.ts` 成唯一实现、删 `panel.ts` 重复注册，行为暂保持 v0）；② 版本化回执协议（请求/回执数据类、四要素身份、前端 v1 解析回执、Comm 生命周期，保留 `on_cell_id` 兼容）；③ 执行协调器（批次登记、串行派发、幂等、超时、fail-fast、新遥测）；④ 单一状态机（新增 `workflow.py`、所有状态修改改走 `transition()`、删除前后端 `_busy` 和 `_auto_pending`、就绪只由进入 IDLE 产生、加带 revision 的快照与重连同步）；⑤ 真实 E2E 与默认开启（Playwright + 真实内核，通过后默认开启、清理 v0）。

## 17. 文件级改动（逻辑位置速查）

- **新增**：单元格执行模块 `cell_execution.py`、状态机 `workflow.py`，以及对应的三份测试（单元格执行、状态机、执行 E2E）。
- **修改**：通用 Comm 辅助 `comm.py`、渲染 `render.py`、中枢 `magic.py`、前端 `comm.ts`/`index.ts`/`panel.ts`、前端编译产物 `lib/*`，以及若干测试和 `.env.example`、开发文档。
- **一条工程纪律**：前端 `lib/`（编译产物）必须与 `src/`（源码）同步提交，否则运行副本和源码会不一致。

## 18. 测试设计（覆盖点）

**Python 单测**分三块：Comm 层（v1 请求序列化、非法回执拒绝、终态后关闭 Comm、回调只触发一次、活跃 Comm 强引用释放、v0 兼容）；协调器（单/多单元格成功、第二个失败后剩余取消、落地超时、执行超时、重复回执、乱序回执、孤儿请求、批次/内核/Notebook 不匹配、非自动 materialized 即完成、自动修复建新批次）；状态机（每条合法迁移、每条非法迁移、三个能力属性、Stop 从每个非 IDLE 收口、进 IDLE 只产生一次就绪、待切换 Notebook 以最后一次为准）。

**TypeScript 测试**把 handler 主体抽成可注入依赖的函数，Mock 掉窗口跟踪器、Notebook 模型、会话上下文、Comm 和 `NotebookActions` 信号，覆盖精确路径、内核不匹配、create/replace/replace 找不到、运行已有单元格、Markdown、不自动执行、控件重试超时、执行成功、内核错误失败、重复信号去重、Comm 发送失败。

**真实 Jupyter E2E** 必须用真实的 `skillbot` 内核和 JupyterLab 页面，覆盖 10 个场景：单个成功单元格、两个有依赖单元格的严格顺序、第二个抛异常的 fail-fast、执行中切 Notebook（确认仍落原 Notebook）、执行中重启内核（确认批次取消回 IDLE）、执行中 Stop（确认不派发后续）、替换不存在单元格（确认 rejected 而非新建）、重复终态回执不产生两次就绪、前端扩展未加载时落地超时、刷新页面后旧批次不自动重放。这类场景要对 DOM、Notebook 模型、内核状态、后台遥测四方一起断言，像素级检查不适用。

## 19. 验收标准

- **功能**：100% 的 Agent 自动执行请求都有请求 ID 和批次 ID；100% 的请求都进入明确终态；多单元格顺序稳定；前端创建/执行失败在面板可见；内核/Notebook 不匹配时拒绝、不串写；Stop 和内核重启后最终都回到 `IDLE`。
- **一致性**：源码里 grep（全文搜索）应搜不到 `_busy`、`_auto_pending`，也搜不到 `magic.py` 里业务函数直接写 `self._state =`，前端也不得保留 `_busy` 作为工作流真相源——状态赋值只允许在 `WorkflowStateMachine` 内部。
- **质量**：Python/TypeScript 新增单测全绿、既有测试无新增失败、修好当时 3 个陈旧的 `trace=True` 测试（避免用既有红灯掩盖回归）、TypeScript 类型检查通过、前端 webpack 构建通过并同步 `lib/`、10 个 E2E 场景全过。
- **可观测**：孤儿回执率为 0、非法迁移率为 0、正常环境落地超时率为 0、每个批次都能用 `batch_id` 把请求/回执/状态迁移/单元格遥测串起来。

## 20. 主要风险与缓解

- **执行期间 Comm 断开**（收不到终态回执）：靠活跃 Comm 强引用 + 执行超时 + 内核变化主动取消兜底；`post_run_cell` 只用于诊断，第一版不让它跟状态机抢真相源。
- **JupyterLab 信号行为随升级变化**：当前依赖版本支持 `executionScheduled`/`executed`，加 TypeScript 契约测试和真实 E2E，升级依赖时把 E2E 当门禁。
- **用户改了单元格元数据导致关联不上**：请求从创建到执行间隔很短，前端内存里另存一份 `cell_id → request_id` 映射，元数据只是恢复和调试的辅助、不是唯一运行时映射。
- **状态机改造范围大导致回归**：先协议、后协调器、最后状态机，每个提交独立可测，用特性开关双路径并存，不把子 Agent/DAG 混进同一个 PR。
- **自动修复死循环**：重试预算存在工作流上下文里，每次修复建新批次，达上限发 `AUTO_FIX_EXHAUSTED`，旧批次不复活。

## 21. 这套闭环解锁了什么后续能力

本设计做完后，才能可靠地建设三类后续能力——**受控子 Agent**（主 Agent 能判断各子任务是否真正完成，而不是只知道“任务已发出”）、**执行型 Skill 的输入输出契约**（可以绑定请求/批次并有确定终态）、**DAG 编排**（节点的完成/失败/超时/取消有统一语义）。但**本设计本身不预设一定要上子 Agent**：即使后续子 Agent 实验没有收益，这套 Comm 闭环和单一状态机仍能独立解决当前的真实痛点——自动执行不可观测、Notebook 切换可能错配、状态重复、失败无法可靠收口、E2E 难以断言。

## 22. 被否决的替代方案（答辩防守用）

- **后端同步等待 Comm**：否决，因为下一个单元格还得用同一个内核，同步等待会自锁或超时。
- **继续只靠 `post_run_cell + _auto_pending`**：否决，没有请求/批次身份，处理不了创建失败、重复执行、迟到事件和 Notebook/内核错配。
- **只加回执、不改状态机**：否决，回执带来更多异步事件，若还让业务函数直接改 `_state/_busy`，竞态面反而更大。
- **只删 `_busy`、保留直接写 `_state`**：否决，字段是少了，但合法迁移校验、幂等、统一 UI 副作用、非法事件检测都还没有，不构成真正的单一状态机。
- **让前端焦点 Notebook 决定目标**：否决，用户切标签页后可能把 Agent 代码写进错误 Notebook，这是数据边界问题，必须用请求身份精确匹配。
- **同一个 PR 里引入子 Agent 或 DAG**：否决，会扩大变量和故障面，无法判断回执/状态机本身是否正确。

## 23. 推荐实施顺序

`P0.1` 前端执行去重 → `P0.2` v1 请求/回执协议 → `P0.3` 协调器 + 串行批次 → `P1.1` 状态机 → `P1.2` 删除 `_busy`/`_auto_pending`/直接状态赋值 → `P1.3` 真实 Jupyter E2E → `P1.4` 默认开启并删旧路径。在 `P1.3` 通过前，不开始并行子 Agent 的 MVP（最小可行验证）。

## 24. 实施状态（2026-09-08，答辩报数以现场为准）

**`P0.1–P1.2` 已完成代码实施**：前端只保留一个 `skillbot:execute-cell` 频道；v1 请求/回执协议已接入；`ExecutionCoordinator` 已实现串行批次、fail-fast、幂等、乱序保护、落地/执行两级超时和取消；`WorkflowStateMachine` 已成为后端唯一工作流状态源；前后端的 `_busy` 与 `_auto_pending` 已移除；面板改用带单调 `revision` 的 `workflow_state` 快照；Notebook 路径与内核 ID 校验已接入；工作流启动时固定目标 Notebook，切标签页不会改变后续确认或自动修复的写入目标；超时回调调度回内核 I/O 循环，避免工作线程直接操作 Comm；终态迁移统一清理待执行结果、自动修复上下文和单元格跟踪；`src/` 与 `extension/lib/` 已同步构建。

**真实 JupyterLab 4.6.0 端到端已验证三条关键链路**：

1. 成功单元格收到完整的 `received → materialized → started → succeeded`，输出 `skillbot-comm-e2e-ok-v2`，批次进终态，工作流回到 `IDLE`。
2. 失败单元格收到 `received → materialized → started → failed`，错误为 `RuntimeError: skillbot-comm-e2e-fail`，批次进终态，工作流回到 `IDLE`。
3. 错误内核 ID 的请求收到 `rejected`，错误码 `KERNEL_MISMATCH`，且**没有创建单元格**。
4. E2E 首轮发现一个竞态：终态回执发送后前端**立即**关闭 Comm，会触发 JupyterLab 4.6 的 Comm/子壳清理竞态，表现为“单元格已执行但后端停在 `CELL_EXECUTING`”。修复办法是改成**由后端在收到终态回执后关闭 Comm**，修复后成功与失败终态都能稳定送达。

**自动化的当前限制**（如实说明）：Stop/取消的 Python 单测已覆盖；但浏览器自动化没能在 30 秒窗口内稳定定位并点到面板的 Stop 控件，所以“真实 UI 点击 Stop”仍保留为人工验收项；其余 7 个扩展 E2E 场景还需在 CI 或稳定的 Playwright 环境补齐，**当前不能宣称第 18 节全部 10 个场景都通过**。

**当前验证结果**：`tests/jupyter` 155 passed；前端 TypeScript 类型检查（`tsc --noEmit`）通过；JupyterLab 扩展 webpack 构建通过。`P1.3` 已完成成功、失败、内核不匹配三条关键链路，尚缺 Stop UI 和完整 10 场景自动化；`P1.4` 暂不执行，旧协议兼容路径继续保留。
