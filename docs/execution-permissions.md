# 统一执行权限控制（脱离仓库可独立阅读版）

> 本文脱离代码仓库也能读懂。出现的英文名（如 `ToolPolicy`、`PreToolUse`、`ExecutionMode`）是代码里的真实符号，保留是为了答辩对齐术语，每个都配了中文解释。「在 xxx.py 中」只表明逻辑位置，正文已把逻辑讲清。

## 范围与定位

把两件事接到**同一套权限模式策略**下管：一是 Claude SDK（模型）的工具调用，二是 SkillBot 自动往 Notebook 里派发/执行代码单元格。**权限由程序代码检查，提示词里的说明只用来引导模型、不是安全控制点**——也就是说，不能靠“在 prompt 里叮嘱模型别乱来”当防线。

这是**可信本地环境下的应用级权限控制**，不是操作系统沙箱，也不是多租户鉴权系统。当前版本的 Notebook Agent 只支持 `claude-code` 这一个后端；其它后端还没接权限协议，初始化时会直接拒绝运行（对应前面多 Agent 文档里说的“fail-closed 失败即关闭”）。

## 权限矩阵

五种执行模式 `ExecutionMode` 对四类操作的授权：

| 模式 | SDK 受限读取 | SDK 写/改文件 | 生成或替换代码 Cell | 自动运行 Cell |
| --- | --- | --- | --- | --- |
| `default`（默认） | 允许 | 拒绝 | 等待用户确认 | 等待用户确认 |
| `plan`（仅计划） | 允许 | 拒绝 | 等待用户确认 | 等待用户确认 |
| `edit`（仅编辑） | 允许 | 拒绝 | 允许 | 拒绝 |
| `execute`（可执行） | 允许 | 仅限会话产物目录 | 允许 | 允许 |
| `auto`（自动） | 允许 | 仅限会话产物目录 | 允许 | 允许 |

几个要点：
- 只读模式（default/plan）仍然可以**返回代码文本**、展示计划 Markdown 单元格，但**不会自动建 Cell、不会自动执行**。
- 用户自己手动运行 Notebook 单元格，不受这套策略约束（那是用户的自主操作）。
- Panel 的普通请求只接受 `default / plan / auto` 三种；内部的 `edit / execute` **不能通过普通模式字段直接授予**，必须走确认流程。选择 `auto` 本身就代表用户授予了“当前这一轮工作流”的执行权限。

## 授权的生命周期（什么时候给权、什么时候收权）

1. `default` 模式返回代码后进入“等待确认”状态，**只有确实存在待执行代码时**，用户点 `/continue yes` 才授予 `execute`。
2. `plan` 模式在“计划审阅”状态下，`/confirm yes` 授予 `execute`；`/confirm accept_edits`（仅接受修改）只授予 `edit`。
3. 计划的修改意见始终走 `plan` 模式；纯文本回答直接结束本轮，不进入确认态（这修了“纯文本也误弹确认”的 bug）。
4. 已批准执行的**自动修复**沿用当前工作流的授权，不再逐次确认；重试次数上限不变。
5. 工作流结束、被停止、或出错回到空闲态时**撤权**；已经给过的确认，不能在非确认状态下重新拿来提权。
6. 每个 SDK 请求结束、异常、超时、取消、断连时都清除该请求的策略对象；异常结束还会顺手关闭 SDK 客户端。
7. HTTP 流式生成器在释放会话锁之前，会显式关闭内部生成器，完成请求清理（防止半开状态残留）。

补充规则：
- 显式的“Cell 优化”按用户选了“优化”还是“优化并运行”授予 `edit` 或 `execute`。
- 快照恢复只在空闲态允许，临时授予 `edit`，派发完立刻撤权，且**不运行**恢复后的 Cell。
- **授权粒度是“当前这一轮工作流”**，不是按代码内容哈希、也不是按单条 SQL。确认后的自动修复代码也落在这个授权范围内——所以这**不是“逐条审查任意代码”的保证**，答辩要如实说。

## SDK 工具与文件范围（`ToolPolicy` 怎么判）

**工具白名单**只有 5 个文件类工具：`Read`（读）、`Glob`（按模式找文件）、`Grep`（搜内容）、`Write`（写）、`Edit`（改）。

Claude SDK 的原生 `Skill` 工具**只允许调用当前已安装且启用的 Skill 名字**；未知的、被禁用的、或请求级显式拒绝的 Skill，都由“工具使用前钩子” `PreToolUse`（模型每次要用工具前，SDK 先回调这个钩子问“准不准”）拒绝。

**禁用的工具**：`Bash`（执行 shell）、`NotebookEdit`、`Agent` / `Task`（派生子 agent）、`WebFetch` / `WebSearch`（联网）、`EnterPlanMode` / `ExitPlanMode`（模型自带计划模式）。其它未知工具和 MCP 工具默认拒绝。

**由此形成明确的能力收缩**：SDK 不能直接执行 Shell、装依赖、调原生子 Agent。Skill 只提供“受控指令 + 知识读取”，不放大它内部步骤的工具权限；真要算数、装依赖，仍得返回 Notebook 代码、走用户批准。

**默认可读根目录**：
- 服务配置的工作目录（环境变量 `CLAUDE_SERVER_WORK_DIR`，没配就是 Claude 隔离 HOME 下的 `run/`）；
- Claude 隔离 HOME 下的 `.claude/skills/`（Skill 目录）；
- 运维额外追加的目录（环境变量 `CLAUDE_SERVER_READ_ROOTS`，多个用系统路径分隔符隔开）。

**SDK 写入只允许**工作目录下的 `artifacts/<服务端会话ID>/`（每个会话一个产物子目录）。路径检查包含：规范化（解析 `..`、软链接）、越界检查、隐藏路径拒绝、硬链接拒绝、写根目录被软链接替换的拒绝、以及特殊文件拒绝。

**一个真实坑**：Skill 同步时会删掉仅用于 Git 占位的 `.gitkeep` 文件——否则保守的“递归搜索安全检查”会因为遇到这个隐藏占位文件，把整个 Skill 目录的搜索都拒绝掉。递归 `Glob/Grep` 的目标目录树里如果含隐藏项、软链接或硬链接，会**保守地拒绝整个搜索**（可以改用范围更小、更合规的目录）。注意：可读范围不是严格的跨会话数据隔离。

环境变量 `CLAUDE_SERVER_ALLOWED_TOOLS` / `CLAUDE_SERVER_DISALLOWED_TOOLS` 是**服务器级的权限上限**；单个请求里传的 `allowed_tools` 只能在此基础上**收窄，不能扩权**。

## 控制点（这套策略分散在哪些地方执行）

- 权限策略本身（模式定义、Cell 权限矩阵、SDK 工具与路径判定）在 `permissions.py`。
- SDK 请求的实际拦截（`PreToolUse` 钩子检查、请求级策略、生命周期清理、决策日志）在服务端会话文件 `session.py`。
- HTTP 层的请求模式校验、把模式透传给三个路由，在 `app.py`。
- 客户端适配器 `claude.py` 负责透传模式，并拒绝“不支持权限版本”的旧服务。
- Agent 会话 `session.py`（Notebook 侧）在请求前设模式、请求后恢复默认。
- Notebook 中枢 `magic.py` 负责工作流内授权、集中式 Cell 派发检查、终态撤权。
- 兼容派发入口 `comm.py` 也会检查代码 Cell 权限（不给它留后门）。

**为什么以 `PreToolUse` 为主检查点**：SDK 用的是普通权限模式 `permission_mode="default"`，不再用会绕过一切的 `bypassPermissions`。SDK 自带的 `can_use_tool`（能否用某工具的回调）无法覆盖所有已被 SDK 放行的工具，所以主检查点放在 `PreToolUse` 钩子，`can_use_tool` 只作兜底拒绝。复用 SDK 客户端时，已注册的钩子会读取“当前请求的策略”来判断。日志会记录会话、模式、工具名、调用标识、是否放行、原因，但**不主动记录完整的工具入参**（避免泄露数据）。

## 部署与验收

源码和本地 Claude 服务的运行副本是分离的，改完源码要更新运行副本并重启：

```bash
./scripts/install.sh update claude-code
./scripts/run.sh stop claude-code
./scripts/run.sh start claude-code --no-webui
curl -fsS http://127.0.0.1:9000/health
```

健康检查返回里应包含 `"permission_policy_version": 1`（权限策略版本号）。已经在跑的 Jupyter 内核不会自动重载 Python 模块，需要保存 Notebook 后重启内核，再跑一遍 SkillBot 初始化。

**手动验收清单**：
1. `default` 请求生成 `print("permission-check")`，确认前不建也不跑代码 Cell；确认后才执行。
2. `plan` 请求同样任务，选“仅接受修改”，应生成代码 Cell，但没有执行计数、没有输出。
3. `auto` 请求同样任务，应按 Comm 回执流程直接执行，结束回空闲。
4. 取消任务后再发旧的 `/confirm yes` 或 `/continue yes`，在没有待确认任务时**不得执行**。
5. `plan` 请求让 SDK 改文件，应被策略拒绝；且不能退回用 Bash 或原生子 Agent 绕过。

**自动验证命令**：

```bash
PYTHONPATH=src .venv/bin/pytest -q \
  tests/agent tests/jupyter tests/server/test_permissions.py \
  tests/server/test_session.py tests/chat/test_claude_permissions.py \
  --import-mode=importlib
PYTHONPATH=src .venv/bin/pytest -q tests/chat/test_claude.py
SKILLBOT_LIVE_PERMISSION_TEST=1 PYTHONPATH=src .venv/bin/pytest -q \
  tests/server/test_permission_live.py
```

其中真实 SDK 测试在临时目录里：用同一个 SDK 客户端先在 `auto` 模式写入 `APPROVED`，再切到 `plan` 模式尝试覆盖成 `CHANGED`。断言是“确实发生了 Write 调用、但被钩子拒绝、文件内容没变”——**它绕开辅助提示文字，验证的是程序控制点，而不是模型自觉守提示词**。

### 历史验证记录（2026-09-08）

- 权限、Agent、Notebook、服务回归：285 通过；一个已有的 Starlette 弃用警告。
- 其余 Chat 回归：98 通过、34 跳过（与上面有重叠，不累加）。
- 真实 SDK 放行/拒绝复测：1 通过，10.58 秒。
- HTTP 完整回归第一次 12 通过；再跑一次 11 通过、1 失败（模型把“计数回复”写成了代码）。收窄辅助提示后，计数文本、单词流式、真实 Read 三项复测全过（13.22 秒）。
- 提示调整后的服务单测：31 通过；`git diff --check` 通过，Python 编译检查通过。
- 本地服务已更新重启，健康检查权限版本为 1。

浏览器点击验收（Notebook 已保存并重启内核）：
- `default`：确认前保持 3 个 Cell；确认后新增 Cell，执行计数 `[1]`，输出 `PERMISSION_DEFAULT_OK`。
- `plan` + 仅接受修改：先新增 Markdown 计划 Cell；确认后新增代码 Cell，执行计数 `[ ]` 且无输出。
- `auto`：无需二次确认，新增 Cell 执行计数 `[4]`，输出 `PERMISSION_AUTO_OK`。
- 工作流结束后输入旧 `/confirm yes`，面板显示 `No pending plan confirmation.`，Cell 数保持 7。
- 最终保存后未保存标记为 0，服务日志确认内核已重启。

验收时发现 JupyterLab 4.6 里 `sharedModel.cellsChanged` 这个事件不存在了，已改用 `model.cells.changed`，切换 Notebook 时断开旧监听，并兼容空的 `oldValues`。重建后不再出现初始化异常。（wheel 构建未验证，因为当前虚拟环境没装 `hatchling`。）

### 历史验证记录（2026-09-09，Claude Skill）

- 已把 `risk-knowledge-base`（风险知识库）和 `bnpl-rule-set-generator`（BNPL 规则生成）两个 Skill 同步到 Claude 的 `.claude/skills`。
- 首次追踪发现风险 KB 里的 `.gitkeep` 触发了“递归隐藏文件保护”，导致 Skill 根目录的 Grep/Glob 被拒；同步脚本现在会从运行副本里删掉这个 Git 占位文件。
- SDK 原生 `Skill` 改成“当前启用 Skill 名字白名单”；未知或禁用的 Skill 仍然失败即关闭。
- 一个**不提示 Skill 名字**的真实风控问题，模型成功 Grep、Read 了 `PIPO支付风控核心指标口径OnePager.md`，并返回了正确口径和飞书来源。
- 相关合并回归：363 通过；一个已有的 Starlette 弃用警告。

### 历史验证记录（2026-09-09，运行中操舵）

- 操舵只向当前 SDK 客户端发动态输入，不创建并发任务，也不经过繁忙内核的执行队列。
- 每个会话、每次运行分别用随机的会话令牌与控制令牌；消息 ID 幂等，单次运行最多 10 条、单条最多 8000 字符。
- 操舵请求禁止携带执行模式，并继承运行创建时的不可变权限策略。
- 模型产出最终结束消息时先把运行置为“收尾中”，拒绝边界后的新消息；异常结束的已接受消息返回“未消费”。
- 真实 UI 验收：长任务运行中发第二条消息，模型最终输出 `UI_STEERING_OK`，面板显示 `direction applied #1`，结束后控制通道关闭。
- 完整回归：415 通过、35 跳过；TypeScript 和 Python 编译检查通过。协议细节见运行中操舵文档。

## 边界与后续（答辩必答）

- HTTP 调用方、SDK 配置、内核都被视为**可信**；接口接受内部模式，**不防恶意本地客户端提权**。服务只监听回环地址（loopback，即 `127.0.0.1`，仅本机可访问），不能直接当无鉴权公网服务；现有管理接口和 CORS（跨域策略）本版没重构。
- 获批的 Cell 用的是**用户内核**的文件、网络、凭据、数据库权限，不受 SDK 产物目录约束——也就是说，一旦用户批准执行，代码能干的事和用户自己在 Notebook 里跑没区别。
- 没有实现“危险 Python / Shell / SQL 分类”和“数据库写入的单独审批”。
- 文件检查和实际操作不是操作系统级的原子隔离，挡不住外部进程并发替换路径。
- 撤权只能阻止后续的工具调用，**不回滚已完成的副作用，也不保证中止已经在内核里跑起来的代码**。
- 本版未做正式的独立安全审查和生产级沙箱部署。
