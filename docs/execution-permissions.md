# 统一执行权限控制

## 范围

将 Claude SDK 工具调用和 SkillBot 自动派发代码 Cell 接入同一模式策略。
权限由程序检查，Prompt 中的说明仅用于引导模型，不是安全控制点。

这是可信本地环境下的应用级权限控制，不是操作系统沙箱或多租户鉴权系统。
本版 Notebook Agent 仅支持 `claude-code`；其他 backend 尚未接入权限协议，初始化时拒绝运行。

## 权限矩阵

| 模式 | SDK 受限读取 | SDK Write/Edit | 生成或替换代码 Cell | 自动运行 Cell |
| --- | --- | --- | --- | --- |
| `default` | 允许 | 拒绝 | 等待确认 | 等待确认 |
| `plan` | 允许 | 拒绝 | 等待确认 | 等待确认 |
| `edit` | 允许 | 拒绝 | 允许 | 拒绝 |
| `execute` | 允许 | 限会话产物目录 | 允许 | 允许 |
| `auto` | 允许 | 限会话产物目录 | 允许 | 允许 |

只读模式仍可返回代码文本，并展示计划 Markdown Cell；不会自动生成或执行代码 Cell。
用户手动运行 Notebook Cell 不受本策略约束。

Panel 普通请求只接受 `default / plan / auto`，内部的 `edit / execute` 不能通过普通模式字段授予。
选择 Auto 本身代表授予当前工作流执行权限。

## 授权生命周期

1. Default 返回代码后进入 `WAITING_CONFIRM`，只有存在待执行代码时，`/continue yes` 才授予 `execute`。
2. Plan 在 `PLAN_REVIEW` 下，`/confirm yes` 授予 `execute`；`/confirm accept_edits` 仅授予 `edit`。
3. Plan 修改意见始终使用 `plan`；普通纯文本回答直接结束本轮，不进入确认态。
4. 已批准执行的自动修复沿用当前工作流授权，不再逐次确认；现有重试上限保持不变。
5. 工作流结束、停止或错误回到 IDLE 时撤权；已有确认不能在非确认状态重新提权。
6. 每个 SDK 请求结束、异常、超时、取消或断连时清除请求策略；异常结束还会关闭 SDK client。
7. HTTP 流式生成器在释放会话锁前显式关闭内部生成器，完成请求清理。

显式 Cell 优化按用户是否选择执行授予 `edit / execute`。
快照恢复只允许空闲状态，临时授予 `edit`，派发后立即撤权，不运行恢复后的 Cell。

授权粒度是当前工作流，不是代码内容哈希或单条 SQL。
确认后的自动修复代码也在该授权范围内；这不是“逐条审查任意代码”的保证。

## SDK 工具与文件范围

文件工具白名单为 `Read / Glob / Grep / Write / Edit`。
Claude SDK 原生 `Skill` 仅允许调用当前已安装且启用的 Skill 名称，未知、禁用或
请求级显式拒绝的 Skill 仍由 `PreToolUse` hook 拒绝。
`Bash / NotebookEdit / Agent / Task / WebFetch / WebSearch /
EnterPlanMode / ExitPlanMode` 禁用；其他未知工具和 MCP 工具默认拒绝。

因此本版仍有明确的能力收缩：SDK 不能直接执行 Shell、安装依赖或调用原生子 Agent。
Skill 只提供受控指令和知识读取，不扩大其内部步骤的工具权限；计算与依赖安装仍需
返回 Notebook 代码，走用户批准流程。

默认读取根目录：

- 服务的 `CLAUDE_SERVER_WORK_DIR`，未配置时为 Claude HOME 下的 `run/`。
- Claude HOME 下的 `.claude/skills/`。
- 运维配置 `CLAUDE_SERVER_READ_ROOTS` 追加的目录，以 `os.pathsep` 分隔。

SDK 写入仅允许 `WORK_DIR/artifacts/<server-session-id>/`。
路径检查包括规范化、越界、隐藏路径、硬链接、写根符号链接及特殊文件。
Skill 同步会移除仅用于 Git 占位的 `.gitkeep`，避免保守的递归搜索检查因隐藏占位
文件拒绝整个 Skill 目录。
递归 Glob/Grep 的目标树若包含隐藏项、符号链接或硬链接，会保守拒绝整个搜索；
可改用范围更小且合规的目录。读取范围不是严格的跨会话数据隔离。

`CLAUDE_SERVER_ALLOWED_TOOLS`、`CLAUDE_SERVER_DISALLOWED_TOOLS` 是服务器权限上限；
请求中的 `allowed_tools` 只能收窄，不能扩权。

## 控制点

- `src/agent/permissions.py`：模式、Cell 权限矩阵、SDK 工具及路径决策。
- `src/server/session.py`：`PreToolUse` 检查、请求策略、生命周期清理和决策日志。
- `src/server/app.py`：请求模式校验和三个 HTTP 路由的传递。
- `src/chat/claude.py`：传递模式；拒绝不支持权限版本的旧服务。
- `src/agent/session.py`：请求前设置模式，请求后恢复默认模式。
- `src/jupyter/magic.py`：工作流内授权、中央 Cell 派发检查及终态撤权。
- `src/jupyter/comm.py`：兼容派发入口也检查代码 Cell 权限。

SDK 使用 `permission_mode="default"`，不再使用 `bypassPermissions`。
`can_use_tool` 不能覆盖所有已被 SDK 放行的工具，因此以 `PreToolUse` 为主检查点，
`can_use_tool` 作为兜底拒绝。复用 SDK client 时，已注册 hook 读取当前请求策略。
日志记录会话、模式、工具、调用标识、是否允许和原因，不主动记录完整工具入参。

## 部署与验收

源码和本地 Claude 服务运行副本分离，更新源码后需更新运行副本并重启：

```bash
./scripts/install.sh update claude-code
./scripts/run.sh stop claude-code
./scripts/run.sh start claude-code --no-webui
curl -fsS http://127.0.0.1:9000/health
```

健康检查应包含 `"permission_policy_version": 1`。
已有 Jupyter Kernel 不会自动刷新 Python 模块，需保存 Notebook 后重启 Kernel，
再执行原来的 SkillBot 初始化步骤。

手动验收：

1. Default 请求生成 `print("permission-check")`，确认前不生成或运行代码 Cell；确认后执行。
2. Plan 请求同样任务，选择仅接受修改，应生成代码 Cell，但无执行计数和输出。
3. Auto 请求同样任务，应按已有 Comm 回执流程执行，结束后回到空闲。
4. 取消任务后发送旧 `/confirm yes` 或 `/continue yes`，无待确认任务时不得执行。
5. Plan 请求 SDK 修改文件，应被策略拒绝；不能回退到 Bash 或原生子 Agent 绕过。

自动验证命令：

```bash
PYTHONPATH=src .venv/bin/pytest -q \
  tests/agent tests/jupyter tests/server/test_permissions.py \
  tests/server/test_session.py tests/chat/test_claude_permissions.py \
  --import-mode=importlib
PYTHONPATH=src .venv/bin/pytest -q tests/chat/test_claude.py
SKILLBOT_LIVE_PERMISSION_TEST=1 PYTHONPATH=src .venv/bin/pytest -q \
  tests/server/test_permission_live.py
```

真实 SDK 测试在临时目录中，以同一 SDK client 先 Auto 写入 `APPROVED`，
再切 Plan 尝试覆盖为 `CHANGED`。断言实际发生 Write 调用且 hook 拒绝，文件内容不变。
测试绕开辅助权限提示文字，验证的是控制点而非模型自觉遵守提示词。

### 2026-09-08 验证记录

- 权限、Agent、Notebook 和服务回归：285 passed；一个现有 Starlette 弃用警告。
- 其余 Chat 回归：98 passed、34 skipped；与上述专项有重叠，不累加。
- 真实 SDK allow/deny 复测：1 passed，10.58 秒。
- HTTP 完整回归首次 12 passed；再次运行 11 passed、1 failed，模型把计数回复写成代码。
  收窄辅助提示后，计数文本、单词流式回复和真实 Read 三项复测全部通过（13.22 秒）。
- 最后提示调整后的服务单测：31 passed；`git diff --check` 通过，Python 编译检查通过。
- 本地服务已更新重启，健康检查权限版本为 1。

浏览器点击验收已执行，Notebook 已保存并重启 Kernel：

- Default：确认前保持 3 个 Cell；确认后新增 Cell，执行计数为 `[1]`，
  输出 `PERMISSION_DEFAULT_OK`。
- Plan + accept edits：先新增 Markdown 计划 Cell；确认后新增代码 Cell，
  执行计数为 `[ ]` 且无输出。
- Auto：无需二次确认，新增 Cell 执行计数为 `[4]`，
  输出 `PERMISSION_AUTO_OK`。
- 工作流结束后输入旧 `/confirm yes`，面板显示 `No pending plan confirmation.`，
  Cell 数保持 7。
- 最终保存后未保存标记为 0。Jupyter server 日志确认 Kernel 已重启。

验收时发现 JupyterLab 4.6 的 `sharedModel.cellsChanged` 不存在，已改用
`model.cells.changed`，切换 Notebook 时断开旧监听，并兼容空 `oldValues` 项。
重新构建后页面不再出现 SkillBot 的 `connect/sharedModel` 初始化异常。

wheel 构建未验证：当前虚拟环境没有 `hatchling`，未为此额外安装构建依赖。

### 2026-09-09 Claude Skill 验证

- 已同步 `risk-knowledge-base` 与 `bnpl-rule-set-generator` 到 Claude `.claude/skills`。
- 首次 trace 发现风险 KB 的 `.gitkeep` 触发递归隐藏文件保护，导致 Skill 根目录
  Grep/Glob 被拒绝；同步脚本现会从运行副本删除该 Git 占位文件。
- SDK 原生 `Skill` 改为 active Skill 名称白名单；未知或禁用 Skill 仍 fail-closed。
- 不提示 Skill 名称的真实风控问题成功 Grep、Read
  `PIPO支付风控核心指标口径OnePager.md`，并返回正确口径和飞书来源。
- Agent、Jupyter、Server、Claude 与 SkillManager 合并相关回归：`363 passed`；
  一个现有 Starlette 弃用警告。

## 边界与后续

- HTTP 调用者、SDK 配置和 Kernel 被视为可信；接口接受内部模式，不防恶意本地客户端提权。
  保持 loopback 监听，不可直接作为无鉴权公网服务；现有管理接口和 CORS 未在本版重构。
- 获准 Cell 使用用户 Kernel 的文件、网络、凭据和数据库权限，不受 SDK artifact 目录约束。
- 未实现危险 Python、Shell 或 SQL 分类，以及数据库写入的单独审批。
- 文件检查与实际操作不是 OS 原子隔离，不能抵抗外部进程并发替换路径。
- 撤权阻止后续工具调用，不回滚已完成副作用，也不保证中止已经运行的 Kernel 代码。
- 本版未覆盖正式独立安全审查及生产环境沙箱部署。
