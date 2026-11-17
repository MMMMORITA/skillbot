# SkillBot 项目 × 岗位 JD 关键词详解

> 用途：求职面试备战。把岗位 JD（Job Description，职位描述）中的每个工程关键词，对应到 SkillBot 项目里的实际模块。全部用自然语言叙述，方便面试时口头展开。
>
> 评级说明：**强** = 有自研生产级代码；**中** = 有等价机制但非企业级中间件；**弱** = 缺口或间接使用，附转化口径，不可硬吹。

---

## 0. 项目一句话定位

SkillBot 是一个**基于 Plan-and-Execute（先规划后执行）架构的 Notebook Agent Harness（笔记本智能体承载层）**。承载层本身不含推理能力，它的职责是把大模型的输出安全地编排成 Jupyter 里的代码单元格（Cell）执行。

整个工作流循环是：先感知（收集当前 Notebook 的变量和新增 cell）、再组装（拼上系统提示词和权限声明）、然后让大模型流式返回规划或代码、解析返回内容、把代码派发到 Notebook、逐阶段回收执行回执、最后收敛到统一的工作流状态。

**自研边界（面试防守口径）**：自研的是 Comm v1 协议、执行协调器、工作流状态机、权限层、后端抽象层与评测框架；现成底座是 JupyterLab API、IPython Kernel（Python 内核）、claude-agent-sdk 与各开源 Agent。

**技术栈**：Python 3.9+（FastAPI、uvicorn、asyncio、pytest）/ TypeScript（esbuild、JupyterLab 4 Lumino Widget、CodeMirror 6）/ Shell 运维脚本 / 文件型持久化。

**全链路概览**（用一句话讲完）：
浏览器或 JupyterLab 侧边栏 → Node 反向代理（如果走独立 WebUI）→ FastAPI 网关（会话管理、鉴权、流式转发、权限钩子）→ 大模型推理 → 如果有代码要落地，就走 Jupyter 的 Comm 通道发到内核 → 内核创建 Cell、执行、逐阶段回执 → 状态机收敛 + 快照保存 + 事件流水写入。

---

## 1. 后端服务（强）

服务端基于 FastAPI（ASGI 异步 Web 框架）+ uvicorn 服务器，默认跑在 9000 端口。整体是一个"多会话大模型网关"：每个会话持有一条到 claude-agent-sdk 子进程的持久连接，HTTP 层负责会话的创建、销毁、流式消息转发、错误归一化。

一个典型的流式对话请求怎么走？请求进来先查 SessionManager（进程内的字典注册表）拿到对应的 Session 对象；然后**加一把会话级的锁**——这把锁不是性能妥协而是正确性要求：同一个 Notebook 内核的变量命名空间如果被并发执行会污染状态，所以会话内串行、会话间并行；拿到锁之后把消息交给 Session 的流式方法，这个方法内部会把权限策略拼到提示词前面、激活本次运行的上下文、然后把 SDK 的流式事件翻译成统一格式逐块产出给 HTTP 层；HTTP 层用 SSE（Server-Sent Events，服务端推送）格式逐块返回，每块是 "data: JSON\n\n"；任何 RuntimeError 都归一化成 500 带详情，兜底异常统一返回 "Internal server error"。

关键设计细节：
- 流式响应头显式关掉 Nginx 缓冲（X-Accel-Buffering: no）、禁止缓存（Cache-Control: no-cache）、保持连接（Connection: keep-alive），说明理解 SSE 经代理层的坑。
- 超时用 asyncio.wait_for 包住整个流式生成过程，超时就抛异常、关闭连接。
- 流式过程如果被取消或异常退出，finally 里会主动断开 SDK 连接并清理策略对象，保证下次请求是干净状态。

---

## 2. API 设计（强）

API 遵循 RESTful 资源嵌套风格：会话（sessions）是顶层资源，每个会话下可以创建运行（runs），运行可以被插话（steer）或中断（interrupt）。

### 核心接口一览

- **健康检查**（GET /health）：返回服务状态和权限策略版本号。
- **会话管理**（POST /sessions 创建；GET /sessions 列表；GET /sessions/{sid} 详情；DELETE /sessions/{sid} 删除并断连）。创建时返回会话 ID 和 session_token（会话令牌）。
- **运行控制**（POST /sessions/{sid}/runs 预备一次运行，返回 run_id 和 control_token；POST /runs/{run_id}/steer 在流式输出中插话改方向；POST /sessions/{sid}/interrupt 中断当前生成但保留对话上下文）。
- **对话**（POST /chat 非流式；POST /chat/stream 纯文本 token 流；POST /chat/trace 全 trace 流，包含推理过程、工具调用、子智能体生命周期和用量统计）。
- **Skill 管理**（GET /skills 列表；GET /skills/{name} 详情；POST /skills/install 上传 zip 安装；DELETE /skills/{name} 卸载）。

### 三套 SSE 流式协议（自研）

纯文本流只发增量文本 token 和终结帧。全 trace 流事件分型：文本增量、推理思考（完整段落，不用增量 delta 因为会丢失空格格式）、工具调用请求、工具执行结果、子智能体开始/进度/结束、用量统计（成本、轮次、时长、token 数）、插话回执（流式结束时把已接受的插话标记为 applied）。

### 输入校验与安全

- **Pydantic 严格模式**：请求体用 `extra="forbid"` 配置，多传字段直接 422，防参数注入。
- **双令牌**：会话令牌和单次运行控制令牌分开，比较一律用恒定时间比较函数防时序侧信道攻击。
- **插话的完整防护**：插话文本空或超 8000 字 → 422；运行不存在或不在 active 状态 → 409；control_token 不对 → 403；同一个 message_id 重放 → 幂等返回原回执；单次运行插话超限 10 条 → 429；实际注入 SDK 失败 → 回滚字典 → 503。
- **zip 上传防穿越**：只取文件名的最后一段（剥掉所有目录），在临时目录里解压。

---

## 3. 数据模型（强）

项目分三层模型，边界清晰：

**接口层**（Pydantic）：负责外部 HTTP 报文的校验和序列化。包括 ChatRequest（消息、超时、允许工具、执行模式、运行 ID）、SteerRequest（插话请求）、ChatResponse、SessionInfo 等。

**领域层**（dataclass 和 Enum）：是系统真正的业务模型：
- **Task（通用任务）**：带依赖关系的任务，两个集合维护"这个任务阻塞了谁"和"被谁阻塞"，就绪判定就是 pending 且入度为零——这是 Kahn 拓扑排序的思想。
- **CellExecutionRequest（代码落地请求）**：冻结对象，包含请求 ID、批次 ID、笔记本路径、内核 ID、操作类型（创建/替换/执行已存在的）、代码、单元格类型、是否自动执行、批次序号（一次 agent 回复可能产出多个 cell，要保证顺序）、超时（默认 600 秒）、协议版本号。
- **CellExecutionReceipt（执行回执）**：逐阶段回传的回执，phase 字段表示阶段（received → materialized → started → succeeded 等 7 个），还带时间戳、cell_id、执行次数、耗时、错误码和错误信息（截断 2000 字符防爆炸）。
- **CellRequest（运行态）**：正在执行中的请求实体，状态字段是 10 态枚举（排队 → 已发送 → 已接收 → 已物化 → 已开始 → 成功/失败/拒绝/取消/超时），seen_phases 集合做乱序回执去重，timer + timer_generation 处理超时（旧 Timer 触发时对照代际作废）。
- **WorkflowStateSnapshot（工作流快照）**：冻结对象，包含当前状态、单调递增的 revision 版本号、当前批次 ID、完成/总数、提示信息。revision 的价值是：前端或日志可以比对版本号判断是否收到了过期或乱序的事件。
- **RunContext（运行上下文）**：一次对话的运行态，从 prepared → active → closing → completed/failed，附带插话历史。

**持久化层**（文件型，见第 4 节）。

### 两个核心状态机

**Cell 请求 10 态**：队列 → 发送 → 接收 → 物化（即代码已写入 Notebook） → 开始执行 → 成功 / 失败 / 拒绝 / 取消 / 超时。特殊设计：非自动执行或 markdown 单元格，物化即终态（因为后续不由协调器执行）。

**工作流 9 状态 24 事件 9 副作用**：状态机是整个系统的"调度大脑"——合法迁移只有特定路径，非法迁移立即抛异常；每次迁移 revision 加一并回调发布快照。这个设计解决了长流程 Agent 执行中最棘手的"状态一致性"问题。

---

## 4. 数据库（弱：文件型持久化，需转化口径）

### 真实情况（务必诚实）

自研代码**没有使用关系型数据库或 ORM**。持久化全部是文件型：

- **会话事件流水**（JSONL 格式）：每行一个 JSON 事件，覆盖会话开始/结束、每个 cell 的代码输出错误耗时、每次 agent 的 prompt 和 response、工作流状态迁移、hook 裁决结果。内存缓冲，会话结束时批量落盘。
- **Cell 版本快照**：每次 cell 执行后自动保存，内容是代码 + 输出（限 5000 字符）+ 错误（限 2000 字符）+ 时间戳，环形缓冲最多保留 50 版，超限删最旧。
- **Notebook 级快照**：整簿时间线，支持一键回滚。
- **Skill 开关状态**：技能目录里一个 JSON 文件记录启用/禁用集合。

### 间接使用 SQLite（不能算自己写的）

deer-flow 后端用 LangGraph 的 SQLite checkpointer（检查点）做会话持久化；hermes-agent 用 state.db。SkillBot 只做会话 ID 和请求头的透传对接。

### 转化口径（面试直接背）

> "自研层是文件型持久化，这是单机工具的刻意选择：JSONL 是事件流水，天然支持事件溯源回放，评测 Trace 也复用它；零运维、零依赖。模型层我做了三级解耦——接口层管报文、领域层管业务状态、持久化层只管序列化，落 PostgreSQL 只需新增 Repository 实现。SQL 方面我自己写过 Spark SQL 的异步提交/轮询/取消封装（见第 6 节）。"

---

## 5. 缓存（中：无 Redis，但有完整缓存思想）

虽然没有用 Redis，但缓存的核心模式都亲手实现过：

**cache-aside（旁路缓存）**——技能目录扫描的完整三要素：读命中直接返回（磁盘无 I/O）、读未命中后扫描磁盘并回填缓存、写路径（安装/卸载/启用/禁用）主动置空让下次强制重建。

**游标式增量投喂**——维护四个游标（看过的 cell、变量索引、待执行队列、hook 结果），每次只把新增内容喂给模型。本质是"变更增量缓存"，用一点计算换大量 token 成本。

**环形缓冲**——cell 快照 50 版、notebook 快照 50 版，固定空间淘汰最旧。

**Comm 客户端复用**——按内核对象的 id 复用 Comm 通道客户端，避免重复建连。

**TF-IDF 内存索引**——技能检索时名称权重 3、描述权重 1，分词是自研的中英文混合（英文按下划线拆子词、中文 unigram 加 bigram）。

### 防守口径

> "我没有在这个项目里用 Redis，但缓存模式我亲手实现过——cache-aside 的读回填加写失效在技能目录上跑通；增量游标本钱是避免重复计算。上 Redis 差的只是序列化协议、TTL 和多级失效策略，模式不变。"

---

## 6. 消息队列 / 异步任务（中强：asyncio 全家桶）

### 同步 SDK → 异步流的桥接（生产者-消费者）

这是一个设计亮点：4 个异构后端各自的 SDK 调用都是同步阻塞的，我在基类里用一个统一的模式把它们全包装成异步流。怎么做的？开一个无界队列，生产者跑在线程池里（默认 ThreadPoolExecutor，不堵事件循环），循环调用后端的同步流式方法，每产出一块就往队列里塞一个三元组信封（data 表示数据块、error 表示异常、done 表示毒丸关闭信号）。消费侧是个异步生成器，循环从队列取消息，收到 data 就 yield 出去，收到 error 就 raise，收到 done 就 break。

这个设计的价值是：4 个后端各自只需要实现同步的 chat/stream 两个方法，异步能力由基类统一提供，各后端零异步代码。这就是模板方法模式在异步场景的经典应用。

### 并发限流：Semaphore

评测执行器用信号量控制并发，比如默认 5 路并发跑评测题目，同时在跑的 LLM 调用不超过 N，完成一个产出一个（流式汇总）。

### Spark SQL 异步作业

自己写过 Spark SQL 的异步封装：提交（立即返回 job_id 不阻塞）、轮询状态、拉结果（自动注入 DataFrame 变量）、取消。直接查询模式是 analyze（校验 SQL）→ submit → poll（单行刷新进度）→ result。这是教科书式的"长任务异步化 + 状态轮询 + 句柄管理"。

### 前端请求队列

用户连续提交时进入数组排队，串行消费，状态栏显示积压数量（queued:n）。中断或切换会话时清空队列。这是前端侧的背压（backpressure）处理。

### 与真正 MQ 的边界（主动说清是加分项）

> "asyncio.Queue 是进程内、内存态、单消费者，无持久化、无跨进程、无消费组。真要分布式化，把 Queue 换成 Redis Stream 或 Celery broker，消费侧的三信封协议不用动；SQL 作业已经是 submit-poll 模型，天然适配远端队列。"

---

## 7. 任务调度（强：三套调度机制）

### DAG 依赖调度：TaskManager

通用任务的就绪判定逻辑：每个任务有两个集合（阻塞了谁、被谁阻塞），`ready_tasks()` 返回所有 pending 且入度为零的任务。调度器每轮取就绪任务执行，执行完更新状态，拓扑自然往前推进——这就是 Kahn 拓扑排序"入度归零即就绪"的思想。

### Cell 批次执行调度：ExecutionCoordinator（含金量最高的自研模块之一）

Agent 一次回复可能产出多个 cell（比如一个数据加载 + 一个绘图），协调器负责按批次串行派发并逐阶段跟踪回执。核心机制：
- 每个请求入队后经 Comm 通道发往内核，状态推进到已发送；
- 同时启动超时 Timer，用代际标记处理旧 Timer 误伤（Timer 到点时先校验代际，已过期就作废）；
- 每次收到回执按 phase 推进状态，seen_phases 集合做幂等去重（重复/乱序的回执不二次推进）；
- fail_fast 策略：批次里一个失败就取消剩余所有（置 cancelled）；
- 自动修复模式：失败后带着错误信息重新请 agent 修代码，上限 3 次，耗尽就自动退出。

关键常量：协议版本号 1、Comm 通道名 "skillbot:execute-cell"、单 cell 代码上限 10 万字符、默认超时 600 秒。

### 应用级并发编排

评测侧信号量限流并发跑；会话锁和插话锁双锁分离（长流持有的锁和高频插话的锁不互相阻塞，避免一次长对话把所有插话都卡死）。

---

## 8. 权限体系（最强亮点，重篇幅准备）

### 五级执行模式

整个系统的权限根是五级执行模式（execution mode），每级对应两个能力位（能不能物化 cell、能不能执行代码/写文件）：
- **default**（默认只读问答）和 **plan**（规划阶段）：两个能力位全关，plan 模式还强制 agent 的返回里 plan 字段非空且 code 数组为空；
- **edit**：能生成和替换 cell 但不自动跑；
- **execute**：人工确认后执行；
- **auto**：全自动执行加自动修复。

两道门控：第一道检查 cell 权限——非物化模式要拒绝、要求自动执行但模式不允许也要拒绝。第二道是**后端能力门控**：不能强制权限的后端必须直接报错（RuntimeError），而不是静默放行——这就是 fail-closed（失败即关闭、默认拒绝）原则。

### 程序级工具门控（不信 Prompt，只信钩子）

这是权限体系最关键的设计——**每次工具调用都经过程序级裁决钩子，不依赖模型的"自我约束"提示词**。裁决流程：SDK 准备调用某工具时触发 PreToolUse 钩子，钩子拿到工具名和参数，交给 ToolPolicy 的 decide 方法做完整裁决，返回 allow 或 deny 加理由码。关键点：裁决器自身如果抛异常（比如策略对象不存在），也判拒绝——这也是 fail-closed 的体现。

放行的工具只有五个：Read、Glob、Grep、Write、Edit（文件读写和搜索）。硬封的工具：Bash、NotebookEdit、Agent、Task、WebFetch、WebSearch、计划模式切换——全部在配置里写死。

### ToolPolicy 的完整裁决规则（11 条拒绝码，按短路顺序）

1. Skill 分支：禁用列表里的技能直接拒绝；技能参数字符串为空拒绝；不在白名单里的技能拒绝。
2. 工具身份：不在允许的五个工具里拒绝；或调用者传的 allowed_tools/denied_tools 列表里被排除的拒绝。
3. 只读模式写保护：Write/Edit 且当前模式不允许执行拒绝。
4. 路径合法性：空路径、含 NUL 字节拒绝。
5. Glob 注入：绝对路径或含 `..` 拒绝（防跳出授权目录）。
6. **符号链接别名逃逸**：写操作时从授权目录向上溯到工作目录，任一祖先是 symlink 就拒绝——防止"授权目录是软链、实际写到别处"。
7. **路径越界**：resolve（解析所有软链和相对路径）后判断是否在授权目录内。读根 = 工作目录 + 技能目录 + 环境变量指定的额外读根；写根 = 工作目录下的 artifacts/{session_id}（会话隔离产物目录）。
8. **隐藏文件**：相对路径任一段以 `.` 开头拒绝（防 .ssh、.env 等敏感文件）。
9. **硬链接**：st_nlink > 1 拒绝（防通过硬链接改写授权域外文件）。
10. 类型校验：读写接口指向目录拒绝；指向设备文件/socket 等非普通文件拒绝。
11. 递归搜索防别名：Glob/Grep 遍历时发现隐藏路径、symlink、hardlink 拒绝。

### HITL（Human-in-the-Loop，人在回路）

plan 模式产出的规划必须经用户显式授权（yes 执行、accept_edits 编辑后执行、no 拒绝）才能进入执行阶段。用户还可以反馈修订意见，agent 会带着意见重新规划。

### 面试一句话总结

> "权限有三道：模式位（能读/能写/能跑的能力矩阵）、钩子程序裁决（每次工具调用实时判定、默认拒绝）、人工授权门（危险动作必须点头）。持久化的不是'信任'而是'拒绝理由码'，每个 deny 都带可观测 reason。"

---

## 9. 前端页面 / 组件 / 交互流程（中强：两套前端，无 React/Vue）

### 整体架构：插件化 + 双通道通信

前端分两套：一套是 JupyterLab 侧边栏扩展（主战场），一套是独立的零框架 WebUI 控制台。

**JupyterLab 侧边栏扩展**：基于 JupyterLab 4 插件体系，入口注册 4 个独立插件——主面板、SQL 编辑器、产物画廊、Comm 通信通道（autoStart 自动激活）。拆分是职责分离：Comm 通道即使面板关闭也在工作。

**主面板组件**继承 Lumino Widget（JupyterLab 的组件基类），所有样式通过 Shadow DOM 隔离——`attachShadow({ mode: 'open' })` 把面板 CSS 封在影子根里，避免污染 JupyterLab 全局样式，也防止被宿主样式影响。这是嵌入第三方宿主应用的标准做法。

状态管理没有用 Redux/Pinia，因为复杂状态归后端有限状态机管，前端只是它的投影，靠 revision 版本号防乱序。本地状态（当前模式、流式标记、历史记录、计划确认选项下标、prompt 队列等）收敛在 Widget 类字段里。持久化偏好（如会话栏折叠状态）写 localStorage。

### 核心组件

| 组件 | 职责 |
|---|---|
| AgentPanel（主面板） | 输入框、Markdown 渲染、token 级流式输出、Ctrl+T 折叠思考、Shift+Tab 循环模式、历史上下键、kill ring 粘贴 |
| panelPlanConfirm | 计划三选项确认面板：执行 / 编辑后执行 / 拒绝 + 反馈修订输入框 |
| panelRenderer | 按输出类型分流渲染：Markdown 复用宿主 renderMarkdown、代码高亮、图片内联、CSV 转 DataFrame |
| panelSessions | 会话切换条（每个笔记本一个 tab）、折叠状态持久化 |
| panelSkills | /skills 命令进入的交互式技能管理面板：↑↓ 选择、Enter 详情、Space 启用禁用、d 卸载、i 安装 |
| galleryWidget | 产物画廊，展示 agent 产出的 csv/png 等文件 |
| SQL 编辑器 | CodeMirror 6 实现，SQL 高亮、sql-formatter 格式化、%%sql magic 对接 |

### 双通道通信架构（全项目前端最大亮点）

为什么必须两条通道？因为大模型服务和 Jupyter 内核是两个进程，**能操作 Notebook 文档模型、能触发 cell 执行的只有前端扩展**。

**通道 A（应用数据）**：面板通过 SSE 连 FastAPI，拿 token 级流式输出、思考/工具/用量 trace，支持中断和运行中插话。

**通道 B（内核控制）**：内核通过 Jupyter Comm（基于 WebSocket 的内核消息总线）向前端扩展发"执行某个 cell"的请求，通道名固定为 "skillbot:execute-cell"。前端扩展收到请求后的处理链是：
1. **协议路由**：检查 protocol_version 字段，v1 走完整校验，无版本字段走 legacy 兼容，其他版本显式拒绝（UNSUPPORTED_PROTOCOL_VERSION）。
2. **五级身份校验**：请求身份四元组（request_id、batch_id、notebook_path、kernel_id）非空 → 操作类型合法（create/replace/run_existing）→ cell 类型合法 → 笔记本能找到 → **内核 ID 与当前实际内核比对一致**（防把代码发到错的内核）。
3. **物化**：根据操作类型在 Notebook 里创建新 cell、替换已有 cell 源码、或定位到已有 cell，在 cell metadata 里打上 skillbot 标记，发送 "已物化" 回执。
4. **等待就绪**：cell 的可视 widget 是异步渲染的，每 100ms 重试一次、最多 20 次（2 秒），超时回 failed(CELL_WIDGET_TIMEOUT)。
5. **执行**：调用 NotebookActions.runCells 触发执行。
6. **回执由宿主信号驱动**：监听 NotebookActions.executionScheduled 发 started 回执，监听 NotebookActions.executed 发 succeeded/failed 回执（带回执行次数、耗时、错误名和错误信息）——以宿主信号为唯一事实源，不自判。

### 关键工程保障

- **幂等**：每个在途请求维护 phases 集合，发送回执前先判重；在途请求表按 request_id 索引。
- **内核重启自动重连**：WeakSet 记录已注册的内核和已监听的 sessionContext，监听 kernelChanged 信号自动重新 registerCommTarget；WeakSet 还能避免被回收的内核造成内存泄漏。
- **执行结果清理**：终态从在途表删除；Comm.onClose 兜底清理。

### 独立 WebUI

用原生 TypeScript + esbuild，零运行时框架，Node 原生 http 模块托管：URL 前缀命中 API 时反向代理到后端，其余路径返回静态文件，找不到时 fallback 到 index.html 支撑单页路由，上游挂掉返回 502。API 客户端手写 SSE（fetch + ReadableStream + TextDecoder + 按 \n 切行、半行留 buffer 处理粘包），返回 AbortController 支持随时中断。

### 防守口径

> "我没用 React/Vue，因为 JupyterLab 是 Lumino 生态，侧边栏扩展必须遵循它的 Widget 生命周期和插件契约，强行塞 React 会造成双运行时和样式冲突，Shadow DOM 隔离正是这个原因。WebUI 场景足够简单，原生 DOM + esbuild 体积最小。我熟悉组件化、单向数据流、流式渲染、中断这些前端核心问题，只是按运行环境选了最合适的载体。"

---

## 10. 工程化（强）+ CI/CD（弱，本地自动化为主）

### 工程化实打实的部分

- **多后端抽象**：AbstractBackend 基类统一 4 个异构 Agent（deer-flow、nanobot、hermes-agent、claude-code），各后端只需实现同步 chat/stream 方法，基类自动提供异步能力（to_thread + Queue 桥接，模板方法模式）。会话隔离机制各异（有的用 thread_id、有的用请求头、有的用持久连接），全部对上游透明。
- **工具注册框架**：三层数据结构——接口契约（preset，纯 JSON Schema，零依赖）、实现映射（preset → {impl_name → ToolDef}）、偏好路由（set_preferred 切换实现）。register_impl 时可以声明运行时依赖（需要哪些环境变量、需要 import 哪些包），discover 自动扫描目录并探测依赖是否满足，check_all 返回所有缺失依赖的工具列表。契约与实现完全解耦，多实现共存，依赖缺失不崩溃。
- **依赖构建**：hatchling 构建，optional-dependencies 按场景分包（nanobot、jupyter、spark、eval、dev）；前端 esbuild 与 jupyterlab builder 双构建链。
- **Shell 运维体系**：install.sh 负责 clone + uv 虚拟环境 + 依赖安装 + 完整性检查；run.sh 负责 daemon 启停/状态/清理/skill 同步；eval.sh 负责 YAML 驱动的批量评测；jupyter.sh 负责内核启动/扩展重建。
- **配置管理**：四类 Agent 各有模板（yaml/json + .env），首次启动自动同步；/config 命令支持新旧配置 diff 确认。
- **测试体系**：370+ pytest 用例，按模块分层（tools 57、chat 58、eval 83、jupyter 120、hook 14、task 11、server 27），注册了 markers（deerflow、nanobot、hermes、integration、sql），支持按依赖可达性选择性执行；pytest-asyncio strict 模式、pytest-timeout 控制单个用例时长。
- **评测工程**：JSONL/YAML 数据集、可插拔 Grader（register_grader 注册自定义评分函数）、并发跑、trace 采集、产物 .jsonl + .report.txt + summary.txt；支持"技能开启 vs 关闭"A/B、主动废弃不公平实验。

### CI/CD 真实缺口

自研仓库根**没有** GitHub Actions / GitLab CI / Dockerfile（agents/ 目录下的流水线和 Dockerfile 属于第三方开源项目，不算个人产出）。

### 转化口径

> "目前以本地自动化为主：分层 pytest + marker 选择、editable 安装、前端 tsc/esbuild/labextension 构建链、shell daemon 管理。接云端流水线路径很清晰——一个 workflow 里跑 pytest -m 'not integration'、tsc --noEmit、jupyter labextension build，产物归档 skill zip。"（若被追问是否亲手配过线上 CI，诚实回答没有，比被戳穿强。）

---

## 11. 问题定位能力（强：可观测 + 可回放 + 可复现）

### 双层可观测

**实时 Trace**：/chat/trace 接口采集 thinking、tool_use/result、subagent 生命周期、token/cost/时延，把黑盒推理变白盒。

**事后事件流水**：SessionEventRecorder 落 JSONL，含每 cell 的代码/输出/错误/执行序号/耗时、每次 prompt/response、状态机迁移、hook 裁决结果——可逐事件回放整个会话。

### 快速定位的工程手段

- **错误码体系**：权限层 11 条拒绝码（第 8.3 节）；HTTP 层语义化状态码（403 令牌、409 运行态冲突、422 报文、429 超频、503 投递失败）；SDK 失败信息格式化函数把 subtype、stop_reason、api_status、permission_denials、deferred_tool_use 全部展开进错误信息。
- **状态机防错乱**：非法迁移立即抛异常；revision 单调递增，可比对版本号判断乱序或重放。
- **回执幂等去重**：seen_phases 集合 + timer_generation 代际，重复/过期回执不会二次推进状态。
- **中断恢复专项治理**：中断发生在工具执行中途会留下未闭合的 tool_use 块。处理方式：interrupt 时置标志位并记录悬空的 tool_use_id 列表；下次请求前给每个悬空 id 补一条合成的 tool_result（标记 is_error=True、content="interrupted by user"），把 SDK 对话结构补完整让模型可以继续；极端情况（连 id 都没追踪到）直接 disconnect 并重建客户端兜底；fix 自身失败也断连重建，保证下次一定是干净连接。

### 可直接讲的两个真实排障案例

1. **知识库召回失败归因**：早期召回频繁失败，直觉是自研 TF-IDF 算法问题。沿 Trace 链路先查候选池，发现根因是 SKILL.md 的 frontmatter（文件头元数据）损坏导致整篇文档解析落选——候选池为空，与排序算法无关。沉淀规则：**检索排障先验候选池，再谈排序**。
2. **路径不一致**：Hermes 的 Skill 目录在源码与 run.sh sync 中映射不一致，导致"本地好好的、部署就失效"。结论：**运维事实一律以部署脚本为准**，文档与源码冲突时以实际挂载路径为准。

---

## 12. 面试速查附录

### 12.1 关键数字

| 项 | 值 |
|---|---|
| HTTP / WebUI 端口 | 9000 / 5175 |
| 单会话最大轮次 | 50 |
| 单次插话上限 | 10 条/运行，单条 ≤ 8000 字符 |
| 单 cell 代码上限 | 100,000 字符 |
| Cell 执行默认超时 | 600 秒 |
| 快照版本 | cell / notebook 各 50 版环形缓冲 |
| auto-fix 上限 | 3 次 |
| 会话 / 运行令牌 | 各 32 字节 token_urlsafe |
| 测试规模 | 370+ pytest |
| 评测 gold set | 13 篇文档 39 题，pass@1 + 人工复核 |

### 12.2 协议与枚举速记

- **Cell 10 态**：QUEUED / SENT / RECEIVED / MATERIALIZED / STARTED / SUCCEEDED / FAILED / REJECTED / CANCELLED / TIMED_OUT
- **Receipt 7 phase**：RECEIVED / MATERIALIZED / STARTED / SUCCEEDED / FAILED / REJECTED / CANCELLED
- **工作流 9 态**：IDLE / AGENT_STREAMING / PLAN_REVIEW / WAITING_CONFIRM / CELL_DISPATCHING / CELL_EXECUTING / AUTO_FIXING / INTERRUPTING
- **Run 生命周期**：prepared → active → closing → completed / failed

### 12.3 自评匹配度

| JD 关键词 | 评级 | 一句话口径 |
|---|---|---|
| 后端服务 | 强 | FastAPI 多会话异步网关，会话锁、超时、断连重建 |
| API | 强 | RESTful + 三套自研 SSE 协议 + 双令牌 + Pydantic 严格校验 |
| 数据模型 | 强 | 接口/领域/持久化三层分离，10 态请求机 + 9 态工作流机 |
| 任务调度 | 强 | DAG 就绪调度 + Cell 批次串行/幂等/超时 + SQL 异步作业 |
| 权限体系 | 强 | 五级模式 + PreToolUse 钩子程序裁决 + 11 条拒绝码 + HITL + fail-closed |
| 前端/交互/组件 | 中强 | 两套前端，CodeMirror 6 + Lumino，手写 SSE 与请求队列 |
| 异步任务 | 强 | to_thread/Queue/Semaphore/executor 全家桶，中断恢复 |
| 缓存 | 中 | cache-aside + 增量游标 + 环形缓冲，无 Redis |
| 消息队列 | 中 | asyncio.Queue 三信封协议，无分布式 MQ |
| 数据库 | 弱 | 文件型持久化 + 间接 SQLite，给 Repository 演进口径 |
| CI/CD | 弱 | 本地脚本/构建/测试齐备，无云端流水线 |
| 问题定位 | 强 | Trace + JSONL 回放 + 错误码 + 状态机 + 中断修复专项 |

### 12.4 自测问题清单（建议逐题口头作答）

1. 为什么同一会话要加锁？这对吞吐意味着什么？
2. steer 如何做到在一次运行中安全改向？令牌怎么管？重复提交同 message_id 会怎样？
3. /chat/trace 的 SSE 事件有哪几类？thinking 为什么不用增量 delta 而用完整段落？
4. ToolPolicy 如何防住符号链接和硬链接逃逸？为什么写根要限制在 artifacts/{session_id}？
5. POLICY_CHECK_FAILED 为什么也判拒绝？这是什么原则？
6. 中断发生在 tool_use 中途，下一条消息为什么会出问题？怎么修？
7. Cell 回执乱序/重复到达怎么办？超时 Timer 如何避免误伤后来才到的成功回执？
8. asyncio.Queue 桥接里 done 毒丸消息的作用？如果生产者异常而没有 error/done 会怎样？
9. 为什么非自动执行的 cell 把 MATERIALIZED 当终态？
10. 文件型持久化要迁移到 Postgres，哪层改、哪层不动？
