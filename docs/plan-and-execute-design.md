# SkillBot Plan-and-Execute 技术文档（脱离仓库可独立阅读版）

> 本文脱离代码仓库也能读懂。出现的英文名（如 `WorkflowStateMachine`、`_implement_plan`、`SECTIONS["plan"]`）是代码里的真实符号，保留是为了答辩时与提问者对齐术语，每个都配了中文解释。「在 xxx.py 中」只表明逻辑位置，正文已把逻辑讲清，不需读者翻源码。

## 0. 一句话结论

SkillBot 的 Plan-and-Execute（先规划、后执行）**不是**复用某框架自带的 Plan Mode——恰恰相反，Claude 自带的 `EnterPlanMode/ExitPlanMode`（进入/退出计划模式）两个工具被明确列入禁用清单。它是三样东西拼出来的：

1. **Planner（规划器）**：一段“硬约束”系统提示词 + 一份 JSON 输出契约，逼模型这一轮**只产出计划、不产出也不运行代码**。
2. **HITL 门控（Human-In-The-Loop，人在环路）**：用户在 Notebook 里审阅计划，分三档授权（仅生成 / 自动执行 / 修订计划）。
3. **Executor（执行器）**：一个唯一的工作流状态机 + 一套 Comm 执行控制面，做幂等、串行、可回执的代码派发。

三者之间靠三个缓存变量衔接：`_last_plan_prompt`（上一次的原始需求）、`_last_plan_output`（上一次模型产出的完整计划文本）、`_last_plan_result`（解析后的结构化计划，避免重复解析）。

各逻辑在源码的位置：Planner 的硬约束提示词在 `prompt.py` 的 `SECTIONS["plan"]`；输出解析在 `parser.py` 的 `parse`；状态切换在 `workflow.py` 的 `WorkflowStateMachine`；计划落地、三档授权、修订、实现在 `magic.py`（函数 `_on_panel_input / _emit_plan_cell / _handle_panel_confirm / _implement_plan`）；执行控制面在 `cell_execution.py` 的 `ExecutionCoordinator`。

## 1. 整体数据流

```
用户在计划模式下输入需求（mode="plan"）
  │  进入函数 _on_panel_input(文本, mode="plan", cell引用)
  ▼
【Planner 回合】给提示词加上“计划模式硬约束”前缀，再拼上增量上下文、@Cell 引用、用户需求，一起发给模型
  │  流式接收模型输出 → 用 parse() 解析
  │  把 原始需求 / 计划全文 / 解析结果 缓存到 _last_plan_prompt / _last_plan_output / _last_plan_result
  ▼
_emit_plan_cell(计划文本)      —— 把计划写成 Notebook 里一个以 # %%plan 开头的 Markdown 单元格（原地更新，不重复）
通知前端弹出确认框
状态机：AGENT_STREAMING --（模型返回了计划）--> PLAN_REVIEW（等用户确认）
  ▼
【HITL 门控】用户操作进入 _handle_panel_confirm(参数)
  ├─ 确认执行（yes）        → 切到 EXECUTE 模式 → _implement_plan(auto=True)
  ├─ 仅接受修改(accept_edits)→ 切到 EDIT 模式   → _implement_plan(auto=False)  —— 生成代码但不执行
  ├─ 取消（no）             → 触发 USER_REJECTED → 回 IDLE，清理计划
  └─ 其它任意文字           → 保持 PLAN 模式，带上“原始需求+上一版计划+这次反馈”重新规划，不给执行权
  ▼
【Executor】_implement_plan
  ├─ 若计划里已经带了代码块 → 直接把这些代码交给 _submit_code_cells 派发
  └─ 若计划里没有代码 → 再发一段“计划已批准，进入实现模式”的提示词让模型生成代码 → 再派发
  ▼
ExecutionCoordinator + Comm v1：串行派发 / 幂等 / 身份校验 / 逐阶段回执 / 失败即停
```

## 2. Planner：怎么做到“只出计划、不建也不跑代码”

这是三重保证叠加的结果，不是靠模型自觉。

### 2.1 第一重：提示词硬约束 + 输出契约

在 `prompt.py` 里有一段专门的计划模式系统提示词 `SECTIONS["plan"]`，答辩时可能被要求复述要点，核心规则如下：

- 完整的分步计划必须放进 JSON 的 `"plan"` 字段，以 Markdown 形式，**且必须非空**；
- `"code"` 字段**必须是空数组 `[]`**，这一轮不许写任何用户可见代码；
- 这是一个**只读规划回合**：可以用只读工具（读文件 Read、搜内容 Grep、找文件 Glob、列目录 LS）和查知识库来充实计划，但**不许写/改文件、不许执行代码、不许跑查询看实时数据**；
- 涉及风控口径、指标计算、规则调优时，**先查风控知识库**（先读它的索引 index.md / 清单 manifest.json，再 Grep，再读目标文件），并**为引用的指标定义或规则标注来源**；
- 如果计划依赖一些当前不知道的细节（列名、表结构、文件布局），**要在计划里写明假设，并把“验证这些假设”作为用户确认之后的第一步**，现在不许去跑验证；
- 计划要覆盖：数据加载、具体步骤/实验、模型与参数、评估指标、最终交付物——详细到用户可以直接判断要不要批准；
- 只有用户确认后，才切到实现模式生成代码；
- 用户给反馈时，输出修订后的非空 `"plan"`，且仍保持 `"code": []`。

在函数 `_on_panel_input` 里，计划模式会给用户的提示词**加上一个前缀**：`[System: <上面这段计划模式约束>]`，然后再拼接增量上下文和 `@Cell` 引用。所以“不建不跑代码”= 提示词硬规则 + `code:[]` 输出契约 + 只读权限，三重叠加。

### 2.2 第二重：权限层兜底

即使模型不守提示词想越界，权限层也拦得住。计划模式属于**只读模式**：在权限策略里，写/改文件类工具只有在“可执行”模式（execute/auto）才放行；建 Cell 需要“可落地”权限（edit/execute/auto）。计划模式两者都不满足，所以规划回合**根本没法建 Cell、没法写盘**。（权限细节见执行权限文档。）

### 2.3 第三重：解析分流

模型输出用 `parse()`（四级级联解析，见主技术文档第 7 节）解析成结构化结果 `ParsedResult`。计划回合取其中的 `plan` 字段作为计划文本，`code_list`（代码列表）此时应为空。解析结果缓存进 `_last_plan_result`，供用户确认后直接复用，不必再解析一次。

## 3. HITL 门控：Planner 与 Executor 之间的用户闸门

### 3.1 计划写进 Notebook

函数 `_emit_plan_cell` 把计划渲染成一个以 `# %%plan` 开头的 **Markdown 单元格**。它复用同一个单元格 ID（`replace_cell_id` 指向 `_plan_cell_id`）做**原地更新**——所以“修订计划”不会每改一次就多出一个计划单元格，而且这个 ID 会记进内核变量 `__plan_cell_id__`。这样计划和后续实验代码留在同一个 Notebook 里对齐，而不是只躺在聊天面板中。

### 3.2 三档授权（函数 `_handle_panel_confirm`）

| 用户输入 | 授权模式 | 行为 |
| --- | --- | --- |
| `/confirm yes`（确认执行） | `EXECUTE`（可执行） | 调 `_implement_plan(auto=True)`：生成并自动执行 |
| `/confirm accept_edits`（仅接受修改） | `EDIT`（仅编辑） | 调 `_implement_plan(auto=False)`：**只生成代码，不执行**，用户审查后手动跑 |
| `/confirm no`（取消） | — | 触发 `USER_REJECTED`，回 IDLE，清空三个缓存 |
| 其它任意文字 | `PLAN`（仅计划） | **重新规划**：把“计划模式约束 + 用户反馈 + 原始需求 + 上一版计划”一起重发，刷新缓存后再次弹确认——**反馈不授予执行权限** |

**设计取舍**：一个“Yes”不能既代表“认可思路”又代表“同意执行”。所以把“认可方案”“授权执行”“反馈迭代”拆成三个独立动作。

### 3.3 状态机保证门控不可绕过

在状态机 `WorkflowStateMachine`（文件 workflow.py）里：

- `AGENT_STREAMING`（生成中）收到“模型返回了计划” → 转到 `PLAN_REVIEW`（等确认），并触发“弹计划确认框”的效果。
- `PLAN_REVIEW` 收到“用户已确认”：看附带的 `has_code`（计划里是否已有现成代码）——有 → 转到派发态，触发“建执行批次”；没有 → 回到生成态，让模型据计划生成实现代码。
- `PLAN_REVIEW` 收到“请求修订计划” → 回到生成态（重新规划）。
- `PLAN_REVIEW` 收到“用户拒绝” → 回 IDLE。
- **只有处在 `PLAN_REVIEW` 才接受确认**：`_handle_panel_confirm` 第一行就判断“当前不是 PLAN_REVIEW 就直接拒绝”，所以任务取消或结束后，用户手里那个旧确认按钮再点也无效——这封死了“旧确认被重放”的隐患。

## 4. Executor：确认之后怎么落地（函数 `_implement_plan`）

1. 用缓存的解析结果，并把其中的 `plan` 字段清空（因为计划已经作为 Markdown 单元格显示过了，避免再渲染出一个重复的计划单元格）。
2. 清空临时状态（本轮生成的 Cell 记录、自动修复计数）。
3. **如果计划里已经带了代码块** → 直接把这些代码交给 `_submit_code_cells` 去派发执行。
4. **如果计划里没有代码** → 再发一段提示词，内容是“计划模式已结束、计划已批准、现在进入实现模式，请据下面这份已批准的计划生成可直接运行的代码”，把模型切到实现模式生成代码，再派发。这一步走“用户已确认（无现成代码）”的状态转移。

`_submit_code_cells` 最终把代码交给执行协调器 `ExecutionCoordinator`（文件 cell_execution.py）——它负责串行调度、Comm v1 逐阶段回执、身份校验（Notebook 路径/内核 ID/批次 ID/请求 ID）、重复/迟到/乱序回执丢弃、两级超时、失败即停。这部分是 Executor 的执行控制面，详见主技术文档第 1.4 与第 6 节。

## 5. 与相关能力的关系

- **运行中操舵（In-Run Steering）**：Executor 执行途中若要改方向，走一条独立的 HTTP 控制通道，在同一次运行里热应用新指令，不新建任务、不提权（操舵继承当前运行的权限）。见运行中操舵文档。
- **知识库**：Planner 的只读规划回合会优先查风控知识库来充实计划、并标注来源，让计划贴合内部口径。
- **可观测**：`workflow_state`（状态变化）、`agent_prompt`（发给模型的提示）、`agent_response`（模型回复）、`agent_continue`（用户确认选择）等事件都会落盘，可以完整回放“出计划 → 确认 → 执行”整条链路。

## 6. QA 速答

- **Q：这是 LangChain / Claude 自带的 Plan-and-Execute 吗？** 不是。Claude 的进入/退出计划模式工具被禁用；Planner 靠自研的计划模式提示词 `SECTIONS["plan"]` 加 `code:[]` 输出契约，Executor 靠自研状态机加 Comm，两者之间靠 magic 里缓存的三个 `_last_plan_*` 变量衔接。
- **Q：怎么保证计划阶段绝不跑代码？** 三重：提示词硬规则（只读、`code` 必须空数组）+ 计划模式的只读权限（写文件、建 Cell 都不放行）+ 状态机根本不进入派发态。
- **Q：修订计划会不会顺带执行？** 不会。任何不是 yes/accept_edits/no 的输入都按计划模式重新规划，权限不升级，仍要再次确认才可能执行。
- **Q：计划在哪、会不会越改越多？** 计划是 Notebook 里一个 `# %%plan` 的 Markdown 单元格，复用同一个单元格 ID 原地更新，修订不新增。
- **Q：Planner 和 Executor 是两个模型/两个进程吗？** 不是。是**同一个 Claude 会话的两个阶段**，靠系统提示词前缀（计划 vs 实现）和权限模式来区分，不是两个独立模型。这一点答辩要如实说，别讲成“双 Agent”。
