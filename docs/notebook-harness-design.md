# Notebook Agent Harness 技术设计（脱离仓库可独立阅读版）

> 本文脱离代码仓库也能读懂。出现的英文名（如 `AgentMagic`、`ExecutionCoordinator`、`WorkflowStateMachine`、`PreToolUse`、`materialized`）是代码里的真实符号，保留是为了答辩对齐术语，每个都配了中文解释。「在 xxx.py / xxx.ts 中」只表明逻辑位置，正文已把逻辑讲清。
>
> 定位：这是 SkillBot「Notebook Agent 承载层（harness）」的**总纲文档**，把执行回执、单一状态机、权限、操舵、多后端这几份专项设计串成一条统一叙事。想看某个子系统的更细版本，去对应专项文档；想快速理解"整个 harness 怎么把一个只会说话的模型变成能在 Notebook 里干活的 Agent"，读本文即可。

## 1. 什么是 Harness（先对齐概念）

**Harness = Agent 承载层 / 运行时脚手架。** 它是包在大语言模型（LLM）外面的一整套编排循环，**本身不含推理能力**，干的是把"一个只会生成文本的模型"变成"能在 JupyterLab 里实际干活的 Agent"这件事。

一个 LLM 单独存在时，它只能做一件事：给它一段文本，它续写一段文本。它不知道当前 Notebook 里有哪些变量、上一格代码报了什么错、用户有没有授权它执行、它生成的代码到底跑成功没有。**把这些"感知—决策—执行—反馈"缝起来的那层代码，就是 harness。** 具体承担五件事：

1. **组装上下文**：把系统提示、历史对话、Notebook 命名空间、检索到的 Skill 拼成模型能理解的输入。
2. **流式接收并解析**模型输出：区分"哪段是给用户看的文本、哪段是要落进 Notebook 的代码、哪段是工具调用、哪段是计划"。
3. **派发副作用并回喂结果**：真去创建单元格、执行代码、调工具，再把执行结果喂回给模型做下一步决策。
4. **门控与状态**：权限校验、人工确认、单一状态机、停止与运行中操舵。
5. **可观测**：把整条链路的事件记录下来，供调试和评测。

> 这个词和大模型系统提示里的 `# Harness` 段是同一个意思——描述"这个模型被什么样的运行时包着、工具怎么跑、输出怎么被渲染"。本文写的就是 SkillBot 自己实现的这套运行时。

### 1.1 自研 vs 现成：一张边界表

harness **站在现成框架的肩膀上，但闭环逻辑是自研的**。这条边界答辩必须说清楚：

| 层次 | 用的现成能力（不自研） | 提供的原语 |
|---|---|---|
| 模型推理 | Claude Agent SDK | `ClaudeSDKClient.query()` 动态输入、`PreToolUse` 钩子、`permission_mode` 权限模式 |
| Agent 基座 | hermes-agent（团队既有框架） | 会话管理、流式基础设施 |
| Notebook 前端 | JupyterLab 扩展 API | `NotebookActions.executionScheduled/executed` 执行信号、Comm 双向通道、窗口跟踪器 |
| 内核 | IPython + ipykernel | `%%` cell magic（单元格魔法命令）、`post_run_cell` 钩子、连接文件取内核 ID |

| 层次 | 自研的 harness 本体（本文重点） | 解决什么 |
|---|---|---|
| 执行闭环 | Comm v1 回执协议 + `ExecutionCoordinator`（执行协调器） | 让"发出去就失联"变成全程可观测 |
| 状态管理 | `WorkflowStateMachine`（单一工作流状态机） | 消灭前后端双 `_busy` 多真相源 |
| 权限门控 | `ToolPolicy` + `ExecutionMode` + `PreToolUse` 检查点 | 程序级收敛能力，不靠 prompt 约束 |
| 运行中控制 | 两级凭据的操舵通道 + 前端优先中断 | 不停止、不重来地改向 |
| 后端抽象 | `AbstractBackend` + `ChatClient` | 一套 harness 接多种 Agent 后端 |

**一句话口径**：模型推理和 hermes-agent 基座是现成的，我不说这两个是自研；把 JupyterLab / IPython / Claude SDK 的原语缝成"感知 Notebook、可观测、可控、能闭环执行"的这套 harness 是自研的。

## 2. 整体分层架构

harness 横跨三个进程/运行域，从上到下：

```text
┌─────────────────────────────────────────────────────────┐
│ 浏览器：JupyterLab 前端扩展（TypeScript）                 │
│  · Agent Panel 面板：对话、确认、停止、操舵               │
│  · 单元格执行插件：定位 Notebook/内核 → 落地 → 执行 → 回执 │
│  · 监听 NotebookActions 信号，缓存后端下发的状态快照       │
└──────────────┬──────────────────────────────────────────┘
               │ Comm 双向通道（skillbot:execute-cell 等频道）
┌──────────────▼──────────────────────────────────────────┐
│ Notebook 内核进程（Python，IPython + AgentMagic 中枢）    │
│  · AgentMagic：编排循环的总调度，执行状态机产出的副作用   │
│  · WorkflowStateMachine：唯一工作流状态源                 │
│  · ExecutionCoordinator + CellCommClient：执行闭环         │
│  · Namespace / Memory：上下文组装                         │
│  · BlockParser：模型输出解析                              │
│  · post_run_cell 钩子：输出采集、快照、遥测（不碰状态）   │
└──────────────┬──────────────────────────────────────────┘
               │ HTTP（/chat/trace 流式、/sessions/.../steer 操舵）
┌──────────────▼──────────────────────────────────────────┐
│ 本地 Claude 服务（Python，封装 Claude Agent SDK）         │
│  · Session/Run：会话与运行生命周期、动态 query 投递       │
│  · PreToolUse 钩子：程序级权限检查点                      │
│  · 只监听回环地址 127.0.0.1，可信本机环境                 │
└─────────────────────────────────────────────────────────┘
```

**中枢是 `AgentMagic`**（在 `magic.py` 中，可理解为"Notebook 侧的 Agent 调度大脑"）——它是一个内核级单例，持有唯一的 LLM 会话。用户在面板里发的每句话、每次确认、每次停止，都先到它这里，由它驱动整个编排循环。

## 3. 核心编排循环（harness 的灵魂）

这是 harness 最本质的部分：**一次用户指令，如何走完"感知 → 组装 → 推理 → 解析 → 派发 → 回执 → 状态收敛"的完整往返。** 下面是自动执行模式（`auto`）下最典型的一轮，用步骤流讲清：

**第 1 步 · 接收指令并占用状态**
用户在面板发一句话，前端通过内核的执行请求把它交给 `AgentMagic`。状态机收到 `USER_PROMPT_ACCEPTED`（用户指令被接受）事件，从 `IDLE`（空闲）迁移到 `AGENT_STREAMING`（模型流式生成中）。**从这一刻起，面板输入框禁用**——因为状态机的 `accepts_new_prompt`（能否接新指令）只在 `IDLE` 为真。

**第 2 步 · 组装上下文**
harness 把这几样拼成模型输入：系统提示（由 `PromptBuilder` 构建，含权限模式对应的硬约束段）、历史对话（来自会话存储的磁盘镜像）、Notebook 当前状态（`Namespace` 提供的增量上下文——哪些变量、哪些单元格、上一格的输出和报错）、以及命中的 Skill 正文（若检索器命中）。这一步决定了模型"看见"多少现场。

**第 3 步 · 流式推理**
内核通过 HTTP 打到本地 Claude 服务的 `/chat/trace`（带执行追踪的对话接口），服务再调 Claude SDK。模型的输出**流式**返回，harness 一边收一边处理，而不是等全部生成完。

**第 4 步 · 解析输出**
流式文本进入 `BlockParser`（块解析器），用四级级联策略判断这段输出是什么：先试"带 json 标记的围栏代码块"→ 再试"裸 JSON"→ 再试"普通代码围栏"→ 最后按"纯文本"处理。解析结果决定下一步走向：纯文本 → 直接回 `IDLE`（这轮只是回答问题）；计划 → 进 `PLAN_REVIEW`；代码 → 建执行批次。

**第 5 步 · 建批次并派发（进入执行闭环）**
模型返回了要执行的代码，状态机收到 `CELL_BATCH_CREATED`（批次已建），进入 `CELL_DISPATCHING`（派发中）。`ExecutionCoordinator` 把每段代码包成一个带 `request_id`（请求 ID）、`batch_id`（批次 ID）、`notebook_path`（目标 Notebook）、`kernel_id`（目标内核）的**执行请求**，通过 Comm 频道**串行**发给前端——先发第一个。

**第 6 步 · 前端落地并执行**
前端收到请求，先按 Notebook 路径和内核 ID **精确定位**（匹配不上就回 `rejected` 拒绝，绝不写到当前焦点 Notebook），然后创建单元格并回 `materialized`（已落地）、开始执行回 `started`（已开始）、跑完回 `succeeded`（成功）或 `failed`（失败）。这一路回执带着相位（phase）沿 Comm 原路返回。

**第 7 步 · 回执聚合与状态推进**
`ExecutionCoordinator` 按 `request_id + phase` **幂等**地消费回执（重复的忽略、乱序的按规则处理、迟到的不覆盖终态），并翻译成状态机事件：`CELL_STARTED` → 进 `CELL_EXECUTING`（执行中）；`CELL_SUCCEEDED` → 若批次还有下一个就回 `CELL_DISPATCHING` **再发第二个**；全部成功 → `BATCH_SUCCEEDED` → 回 `IDLE`。

**第 8 步 · 旁路采集（不干扰主循环）**
与此同时，内核的 `post_run_cell` 钩子在每个单元格跑完后，**独立地**做输出采集、命名空间更新、快照、遥测。它**不碰工作流状态**——这是原则"执行结果与输出采集分离"的落地：前端回执驱动状态，`post_run_cell` 只负责"这次执行的详情是什么"。

**第 9 步 · 失败则自动修复**
若第 6 步返回 `failed`，协调器 fail-fast（把批次里排队的后续请求取消），状态机进 `AUTO_FIXING`（自动修复中）。harness 把失败单元格的代码、有界错误文本、`post_run_cell` 采集的输出重新组装，回到第 3 步让模型生成修复代码，建**新批次**重试——直到成功或次数耗尽（`AUTO_FIX_EXHAUSTED`）。

**收敛保证**：无论成功、失败、超时、被停止，这个循环最终都收敛回 `IDLE`，面板恢复可输入。整个过程中，状态只由状态机推进，UI 只从状态派生。

## 4. 子系统详解

上面的循环里出现了几个子系统。下面逐个讲清它们各自解决什么、怎么做的。

### 4.1 上下文组装（让模型"看见"现场）

harness 有一套三层记忆机制，对应第 2 步：

- **会话存储（conversation_store）**：对话历史的**磁盘镜像**，按 Notebook 路径隔离。切换 Notebook 时，LLM 记忆要跟着切（否则新 Notebook 会继承上一个的历史）——但注意，切的只是**LLM 记忆**，内核的 Python 命名空间是全内核共享的，做不到按 Notebook 隔离。
- **命名空间增量（`Namespace.delta`）**：把 Notebook 当前的变量、单元格、待执行编辑、上一格输出/报错，以**增量**方式（用几个游标记录"上次喂到哪了"）提供给模型，避免每轮都全量重发。
- **快照（环形缓冲）**：单元格和 Notebook 的历史版本快照，用环形缓冲保留有限版本数，支撑"恢复与复盘"。

系统提示由 `PromptBuilder`（提示构建器）生成，其中 `SECTIONS["plan"]`（计划段）是给"仅计划"模式用的**硬约束**——从提示层就限制模型在计划阶段只读不写。但要强调：**提示只是引导，不是安全控制点**，真正的权限收敛在 4.5。

### 4.2 输出解析（BlockParser 四级级联）

模型的流式输出格式会波动（有时规规矩矩返回 JSON，有时直接甩代码围栏，有时纯聊天）。`BlockParser` 用**四级级联**兜住这种不确定性：`带 json 标记的围栏` → `裸 JSON` → `普通代码围栏` → `纯文本`，逐级降级尝试解析。这样无论模型这轮"守不守格式"，harness 都能稳定地把输出分类成"文本/代码/计划/工具调用"，交给状态机决定走向。

### 4.3 执行闭环（Comm v1 + ExecutionCoordinator）

这是 harness 最核心的自研部分，专门解决旧实现"发出去只拿回一个 `cell_id`、证明不了执行成功"的问题。核心是一套自定义的 **Comm v1 协议**：

- 频道名固定 `skillbot:execute-cell`，`protocol_version=1`。
- 七个回执相位：`received`（已收到）→ `materialized`（已落地）→ `started`（已开始）→ `succeeded`/`failed`，外加 `rejected`（被拒）、`cancelled`（被取消），以及本地生成的 `timed_out`（超时）。
- 每个请求携带四要素身份 `request_id / batch_id / notebook_path / kernel_id`，**身份优先于焦点**——前端必须匹配上目标 Notebook 和内核才写入。

`ExecutionCoordinator`（执行协调器）是这层的大脑：串行派发多单元格（保证数据依赖顺序）、按 `request_id + phase` 幂等去重、两级超时（落地超时 5 秒 / 执行超时 600 秒）、fail-fast、身份校验、自动修复调度。它对外用 `ExecutionBatch`（批次对象）的派生属性（待执行数、终态数、是否成功）表达进度，**不再单独维护 `_auto_pending` 计数**。

> 更细的协议字段、错误码、迁移表见 [Comm 执行回执与单一状态机文档](file:///Users/bytedance/Documents/trae_projects/skillbot/docs/comm-receipt-state-machine-design.md)。

### 4.4 单一状态机（WorkflowStateMachine）

harness 的"状态单一来源"。八个状态：`IDLE`（空闲）、`AGENT_STREAMING`（模型生成中）、`PLAN_REVIEW`（计划审阅）、`WAITING_CONFIRM`（等待确认）、`CELL_DISPATCHING`（派发中）、`CELL_EXECUTING`（执行中）、`AUTO_FIXING`（自动修复中）、`INTERRUPTING`（中断收尾中）。

关键设计：

- **用能力属性替代 `_busy`**：`accepts_new_prompt`（能否接新指令）、`awaiting_user`（是否在等用户）、`has_active_work`（是否有活跃工作）等，都从状态派生，消灭了含义模糊的布尔标志。
- **`transition(event)` 只做纯逻辑**：校验合法性、更新状态、产出 `effect`（副作用指令），真正的 I/O 由 `AgentMagic` 执行这些副作用——这样状态机可以脱离 Comm/面板/模型独立单测。
- **单调 `revision`（修订号）快照**：每次有效迁移都下发一个状态快照，前端**只接受 revision 更大的**，从而避免旧 Comm 消息覆盖新状态；重连时前端主动请求最新快照，而不是默认认为"就绪"。
- **非法迁移不猜**：遇到状态表里没有的事件组合，不改状态、记遥测、开发模式抛异常，绝不"猜一个状态"恢复。

### 4.5 权限门控（ToolPolicy + ExecutionMode + PreToolUse）

harness 的安全边界。核心原则：**权限由程序代码检查，提示词只用来引导模型、不是安全控制点**。

- **五种执行模式 `ExecutionMode`**：`default`（默认，读取可以、写改要确认、执行要确认）、`plan`（仅计划）、`edit`（仅编辑，可生成代码不自动跑）、`execute`（可执行）、`auto`（自动）。面板只接受 `default/plan/auto`，内部的 `edit/execute` 必须走确认流程授予。
- **`ToolPolicy` 工具白名单**：SDK 只放行 5 个文件类工具（`Read`/`Glob`/`Grep`/`Write`/`Edit`），禁用 `Bash`（shell）、`Agent`/`Task`（派生子 agent）、`WebFetch`/`WebSearch`（联网）等——形成明确的**能力收缩**：模型不能直接执行 shell、装依赖、调子 Agent，要算数装依赖仍得返回 Notebook 代码走用户批准。
- **`PreToolUse` 作为主检查点**：模型每次要用工具前，SDK 先回调这个钩子问"准不准"。因为 SDK 自带的 `can_use_tool` 覆盖不全，主检查点放在 `PreToolUse`，`can_use_tool` 只兜底。SDK 用普通 `permission_mode="default"`，不用会绕过一切的 `bypassPermissions`。
- **授权粒度是"当前这一轮工作流"**：确认后的自动修复代码也落在这个授权范围内，工作流结束就撤权。

> 更细的权限矩阵、授权生命周期、文件路径检查见 [统一执行权限控制文档](file:///Users/bytedance/Documents/trae_projects/skillbot/docs/execution-permissions.md)。

### 4.6 运行中控制（Steering + Stop）

harness 允许用户在任务跑到一半时干预，而不必推倒重来：

- **运行中操舵（Steering）**：内核繁忙时，用户的第二句话不进执行队列，而是走独立 HTTP 通道直接对**同一个 Claude SDK 客户端**追加动态输入（`ClaudeSDKClient.query()`），让模型在"尚未做出的后续决策"上改向。用两级凭据（`session_token` 会话令牌 + `control_token` 控制令牌）鉴权，`message_id` 幂等，单次运行最多 10 条、单条最多 8000 字符，两段回执 `accepted → applied`。**操舵继承运行创建时的权限，不能提权。**
- **停止（Stop）**：因为内核跑长单元格时后端处理 `/stop` 本身会排队，所以**前端优先直接调 `kernel.interrupt()`（中断内核）**，再发 `/stop`，最后由状态机发布权威的 `INTERRUPTING → IDLE` 快照。第一版不承诺撤销已进内核队列的执行，但保证不再派发后续单元格、终态最终收敛、不把迟到成功当新任务结果。

> 更细的操舵通信路径和协议见 [运行中操舵文档](file:///Users/bytedance/Documents/trae_projects/skillbot/docs/in-run-steering.md)。

### 4.7 多后端抽象（AbstractBackend + ChatClient）

harness 不绑死单一 Agent 实现。`AbstractBackend`（抽象后端）定义统一接口，`ChatClient`（对话客户端）在上层统一调度，目前接了 claude-code / hermes / nanobot / deer-flow 四种后端。每种后端把自己的流式格式翻译成统一的 `StreamChunk`（流式片段）/`TraceBlock`（追踪块），于是上层的解析、状态机、UI 完全不用关心底下是哪家。Skill 可以跨后端复用。

> 注意：当前 Notebook Agent 的**执行权限协议只有 `claude-code` 后端实现**，其它后端接入执行前会 fail-closed（失败即关闭）。更细见多 Agent 管理文档。

### 4.8 可观测（Telemetry）

`SessionEventRecorder`（会话事件记录器，缓冲式写 JSONL）把整条链路的事件落盘：请求创建、回执、超时、重复/孤儿回执、批次完成、状态迁移。字段做了隐私处理——不记完整代码、Notebook 路径哈希、内核 ID 截断、错误文本截断。由此可算出落地成功率、执行成功率、各类超时率、孤儿回执率、非法迁移率、批次耗时 P50/P95 等监控指标，也支撑离线评测（`AsyncEvalRunner` 并发跑题库、子串匹配打分）。

## 5. 关键设计权衡（答辩防守）

- **为什么不同步等待执行？** 因为下一个单元格还得用同一个内核跑，同步等待会自锁。所以选事件驱动 + 回执聚合。
- **为什么身份优先于焦点？** 用户可能在请求到达前切了标签页，用"当前焦点 Notebook"会把代码写错地方——这是数据边界问题，必须用请求身份精确匹配。
- **为什么权限不靠 prompt？** prompt 约束是概率性的、可被绕过；能力收敛必须落在程序控制点（`PreToolUse` + 工具白名单）。
- **为什么要单一状态机？** 旧的前后端双 `_busy` + 散落赋值有多真相源和竞态；回执带来更多异步事件后，只有集中式合法迁移校验才控得住。
- **为什么自研而不套现成 notebook-agent 框架？** 现成方案解决不了这四个真实痛点：自动执行不可观测、权限不收敛、状态多真相源、Notebook/内核焦点错配可能串写。harness 正是为闭合这四点而生。

## 6. 答辩 QA 速答

**Q：这个 harness 是自研还是用框架？**
A：分层看。模型推理用 Claude Agent SDK、Agent 基座用 hermes-agent、Notebook 前端和内核用 JupyterLab/IPython 的原语——这些是现成的。把它们缝成"感知 Notebook、可观测、可控、能闭环执行"的承载层（Comm 回执协议、执行协调器、单一状态机、权限层、多后端抽象）是自研的。

**Q：harness 到底解决了什么？**
A：把"模型能生成代码"升级成"生成 → 落地 → 执行 → 回执 → 状态收敛"的可观测可控闭环，并在其上叠加了权限门控、运行中操舵、自动修复、多后端复用。

**Q：harness 里最难的一块是什么？**
A：执行闭环 + 单一状态机。难点在于 Comm 回执可能重复、乱序、迟到，内核繁忙时消息还会排队；要用四要素身份 + 幂等规则 + 单调 revision 快照，才能保证状态在各种异步竞态下仍单调收敛到 `IDLE`。

**Q：口径边界？**
A：这是可信本机环境的应用级控制，不是操作系统沙箱；服务只监听回环地址；获批执行的代码用的是用户内核权限，撤权只挡后续调用、不回滚已完成副作用。LLM 本身和 hermes-agent 基座不是我自研。
