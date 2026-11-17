# SkillBot 多 Agent 管理框架技术文档（脱离仓库可独立阅读版）

> 本文脱离代码仓库也能读懂。出现的英文名（如 `ChatClient`、`AbstractBackend`、`StreamChunk`）是代码里的真实符号，保留是为了答辩时对齐术语，每个都配了中文解释。「在 xxx.py 中」只表明逻辑位置，正文已把逻辑讲清。

## 0. 定位与一句话结论

项目自我定位（来自 README）：

> 多 agent 管理框架 —— 统一管理 deer-flow、nanobot、hermes-agent、claude-code，提供一致的命令行运维工具、Python 对话 API 与 Jupyter 交互能力。

**关键澄清：这里的“多 Agent 管理”指“多种异构 Agent 后端（框架）的统一接入与运维”，不是“多个 Agent 同时并行干活”。** 它要解决的痛点是：deer-flow、nanobot、hermes-agent、claude-code 这四种 Agent 框架，启动方式、会话协议、配置文件、Skill 目录、能产出的过程数据都不一样；如果上层（Notebook Harness）直接绑死其中一种，一旦换框架，上层交互和业务逻辑就得重写。

SkillBot 用两条“统一线”把这些差异收进适配层：

1. **运行期统一**：一个统一门面类 `ChatClient` + 一个抽象后端接口 `AbstractBackend`（都是 Python）。
2. **运维期统一**：两个命令行脚本 `install.sh`（安装/更新/卸载/检查）和 `run.sh`（启动/停止/状态/清理/Skill 同步）。

各逻辑位置：统一门面在 `chat/__init__.py` 的 `ChatClient`；后端抽象接口在 `chat/base.py` 的 `AbstractBackend`；四个具体适配器分别在 `chat/deerflow.py`、`chat/nanobot.py`、`chat/hermes.py`、`chat/claude.py`；Skill 资产管理在 `chat/skill.py` 的 `SkillManager`；安装脚本 `scripts/install.sh`；运维脚本 `scripts/run.sh`。

四类后端概览：

| 后端 | 接入方式 | API 端口 | WebUI 端口 | 会话隔离机制 |
| --- | --- | --- | --- | --- |
| deer-flow | git 克隆 + uv 建虚拟环境；LangGraph 的 SSE 流 | 8001 | 3000/2026 | 用 `thread_id`（LangGraph 的 SQLite 检查点持久化） |
| nanobot | git 克隆 + uv 建虚拟环境；OpenAI 兼容 REST | 8900 | 5173 | 用请求头 `X-Nanobot-Session-ID` |
| hermes-agent | git 克隆 + uv 建虚拟环境；OpenAI 兼容 REST | 8642 | 5174 | 用请求头 `X-Hermes-Session-Id` |
| claude-code | npm 安装 + 自研 HTTP 服务（SDK+SSE） | 9000 | 5175 | 服务端用持久的 `ClaudeSDKClient` 连接 |

## 1. 运行期统一：ChatClient + AbstractBackend

### 1.1 统一门面 ChatClient（文件 chat/\_\_init\_\_.py）

`ChatClient`（统一对话客户端）是上层唯一要打交道的类。构造时按传入的 agent 名字，实例化对应的后端对象（合法名字集合是 deer-flow / nanobot / hermes-agent / claude-code，传别的直接报错）。上层代码只依赖 `ChatClient`，完全不感知底下到底是哪个框架。

它对上统一暴露一套能力（同步和异步各一份）：`chat`（发一条、返回完整回复）、`stream`（流式返回文本）、`stream_chunks`（流式返回带过程数据的结构化块）、以及 `interrupt`（中断）、`prepare_run`（为下一次运行准备操舵通道）、`list_sessions`（列会话）、`clear_session`（清会话）。

### 1.2 后端抽象接口 AbstractBackend（文件 chat/base.py）

`AbstractBackend`（抽象后端）定义了“一个后端至少要实现什么”：

- **必须实现的三个方法**（抽象方法）：`chat`、`stream`、`stream_chunks`。这是每个后端的最小可用集。
- **基类给了默认实现、后端按需覆盖的**：
  - 三个异步方法（`async_chat` / `async_stream` / `async_stream_chunks`）：基类统一用“把同步方法丢进线程池跑、再用异步队列往外吐”的方式实现，**所以后端不用各自再写一遍异步版本**。
  - `interrupt` / `list_sessions` / `clear_session`：默认空实现。
  - `prepare_run`（准备操舵通道）：**默认返回 None**——只有 claude-code 覆盖它来开“运行中操舵”的控制通道，别的后端天然不支持，返回 None 即可。
  - `set_execution_mode`（设置执行权限模式）：**默认是“fail-closed（失败即关闭）”——直接抛异常**。这是一个安全关键点：**一个后端如果没有能力强制执行 Notebook 权限，就干脆拒绝进入受权限约束的路径，而不是偷偷放行。**

### 1.3 统一的数据结构 StreamChunk / TraceBlock

不同后端能吐出的“过程数据”差异极大（见下表），但对上都统一成两个结构：`StreamChunk`（流式块，含 `text` 文本、`blocks` 过程块列表、`final` 是否最后一块）和 `TraceBlock`（过程块，含 `type` 类型、`data` 数据、`text` 文本）。过程块类型 `type` 有：`thinking`（思考）、`tool_use`（调用工具）、`tool_result`（工具结果）、`subagent`（子 agent 生命周期）、`usage`（token 用量）。

| 过程数据 | deer-flow | nanobot | hermes | claude-code |
| --- | :-: | :-: | :-: | :-: |
| 思考过程 thinking | — | — | — | ✓ |
| 工具调用/结果 | ✓ | — | ✓ | ✓ |
| 子 agent 生命周期 | — | — | — | ✓ |
| token 用量 | — | — | ✓ | ✓ |

**每个适配器的核心工作，就是把各家五花八门的流，翻译成统一的 `StreamChunk`。** 以 hermes 适配器（文件 chat/hermes.py）为例，它做的翻译是：从 OpenAI 风格 SSE 的 `delta.content` 里取出文本；把跨多个数据块分片到达的 `tool_calls` 拼起来（`arguments` 字段要逐片累加），等收到“结束原因=tool_calls”时产出一个 `tool_use` 过程块；解析 hermes 私有的 `hermes.tool.progress` 事件，按 running/completed 产出 `tool_use`/`tool_result`；末尾的 `usage` 产出 `usage` 块。claude-code 适配器则是从 SDK 返回的各类消息对象（助手消息、思考块、工具调用块、结束消息、子任务消息）翻译成同样的结构。

### 1.4 会话隔离的差异被适配器吸收

上层永远只传一个 `session`（会话）字符串，但四家实现完全不同（见 0 节表）：hermes/nanobot 靠自定义 HTTP 请求头，deer-flow 靠 LangGraph 的 `thread_id`，claude-code 靠服务端一条持久的 SDK 连接。**这些差异全在各适配器内部消化，上层无感。**

## 2. Skill 资产的跨后端复用

### 2.1 目录映射

每个后端把 Skill 放在不同目录，`chat/__init__.py` 里有一张映射表 `_AGENT_SKILL_PATHS`：

```
claude-code  → .claude/skills
deer-flow    → skills/custom
nanobot      → nanobot/skills
hermes-agent → skills（注意：run.sh 里同步用的是 skills/custom）
```

函数 `_resolve_skill_dir` 结合环境变量或默认的 `agents/<后端名>/<映射路径>` 定位到具体目录，`ChatClient` 为每个后端建一个独立的 `SkillManager`（Skill 管理器）。**同一套业务 Skill 资产可以同步进不同后端的目录，复用而不重写。**

（提醒：hermes 的 Skill 目录在代码映射里写的是 `skills`，在运维脚本 `run.sh` 里同步用的是 `skills/custom`，这两处存在一处历史不一致，实际以 `run.sh sync` 落地路径为准。）

### 2.2 注入策略按后端能力分流（函数 `_maybe_inject_skills`）

同一个“注入 Skill”动作，按后端能力差异化处理，体现了“接口统一、实现差异化”：

- **claude-code**：它的 SDK 在启动时会自己加载 Skill，所以框架**不做全量注入**；只有在**会话进行中途**用户 enable/disable 了某个 Skill 时，才注入一条最小的变更通知（“启用了 X / 禁用了 Y，别再用”）。
- **其它后端**：用 `SkillManager.inject_prompt`（注入提示词）主动把 Skill 说明注入进上下文，支持三个环境变量开关：关键词检索的返回条数上限、是否渐进注入、是否开启 LLM 重排。

这解释了“同一份 Skill，claude-code 靠框架原生加载、其它后端靠框架主动注入”的差异化设计。

## 3. 运维期统一：命令行脚本

### 3.1 install.sh（安装/更新/卸载/检查）

命令：`install / update / uninstall / check [后端名]`，另有 `init` 初始化项目虚拟环境。

按后端差异化安装：

- deer-flow / nanobot / hermes：`git 克隆仓库 → uv 建虚拟环境 → 装依赖`；有 WebUI 的再 `npm install` 前端。
- claude-code：**基于 npm，没有 git 克隆**（它的仓库地址返回空），走独立安装路径，再单独装 `server/webui` 前端。

各后端的 GitHub 地址硬编码在脚本的分支里，`check` 命令校验安装是否完整。

### 3.2 run.sh（启动/停止/状态/清理/同步）

命令：`start [后端] [模型] [--no-webui] / stop / status / clean / sync [后端] [skills]`。

每个后端的差异都收进脚本的 case 分支：

- **启动命令**：nanobot 是 `nanobot gateway`、hermes 是 `hermes gateway run --replace`、claude-code 是跑自研服务 `python -c 'from server.app import main; main()'`、deer-flow 有专门分支。
- **配置文件**：deer-flow 用 `config.yaml + .env`、nanobot 用 `config.json`、hermes 用 `config.yaml + .env`、claude-code 用 `settings.json + .env`；首次启动时自动从项目的 `conf/agent_conf/<后端>/` 模板同步到各后端自己的配置目录（claude-code 是隔离 HOME 下的 `.claude/`）。
- **WebUI 端口/目录**：nanobot 5173/`webui`、hermes 5174/`web`、claude-code 5175/`server/webui`（构建后用代理，API 的 9000 端口经 5175 代理出去）。
- **home 目录**：nanobot 是 `.nanobot`、hermes 是 `.hermes`，用于隔离各自的运行状态。

### 3.3 Skill 同步 `run.sh sync`

把仓库里的共享 Skill 同步到指定后端的 Skill 目录（对应 2.1 的映射表），并顺带清理运行目录里的 `.gitkeep` 等隐藏占位文件（否则权限层保守的递归安全检查会因为遇到隐藏文件而整体拒绝搜索）。这是“业务 Skill 一次维护、多后端复用”的运维入口。

## 4. 分层的价值：Hermes → Claude Code 的真实迁移

这套分层最有力的验证，是 Hermes 因网络环境受限、需要把运行时迁移到 claude-code 那次：

- **保留下来的**：整个 Notebook Harness（Panel 面板、Plan 计划审阅、Comm 执行闭环、状态机）、知识库 Skill 资产、上层的 `ChatClient` 调用方式。
- **需要改动的**：只是新增/切换到 claude-code 的适配器，加上 claude-code 的会话、权限、操舵接线。

相当于“换了发动机，没换车身”。这说明多 Agent 管理不只是图运维方便，更**降低了业务能力对单一模型框架的绑定风险**。

## 5. 边界与常见误解（答辩必答）

- **不是多 Agent 并行编排**：这里管理的是“多种后端的统一接入”，同一时刻上层只用其中一个后端。多个 Agent 并行分工、DAG 编排是另一类能力，本项目未纳入。
- **不是抹平所有能力差异**：统一的是**接入与调用接口**，不是让四个框架能力完全一致。过程数据、执行权限、运行中操舵、原生 Skill 加载等，各后端支持度不同（见前面几张表）。当前 Notebook 的统一权限和操舵链路只在 **claude-code** 上完成了验收。
- **fail-closed（失败即关闭）原则**：不能强制 Notebook 权限的后端，`set_execution_mode` 直接抛错——宁可不接入受控路径，也绝不静默放行。
- **prepare_run 只有 claude-code 支持**：其它后端返回 None，运行中操舵在它们上面用不了——这是能力差异的显式体现，不是 bug。

## 6. QA 速答

- **Q：“多 Agent 管理”是不是多个 Agent 一起干活？** 不是。是四类异构 Agent **框架/后端**的统一接入与运维，同一时刻上层用其中一个。
- **Q：加一个新后端要改哪些地方？** 写一个 `AbstractBackend` 的子类（至少实现 chat/stream/stream_chunks，把那个框架的流翻译成统一的 `StreamChunk`），在 `ChatClient` 里注册，在两个运维脚本里加对应的 case 分支和配置模板。上层业务代码不用动。
- **Q：不同后端的会话怎么统一？** 上层只传一个 `session` 字符串，具体隔离机制（HTTP 头 / thread_id / 持久连接）由各适配器内部吸收。
- **Q：Skill 怎么跨后端复用？** 用目录映射表把资产同步到各后端的 Skill 目录，注入策略按后端能力分流（claude-code 原生加载 + 变更通知，其它框架主动注入）。
- **Q：迁移到 Claude Code 为什么没重写整个产品？** 因为框架差异都被 `AbstractBackend` 适配层和运维脚本的 case 分支收敛住了，业务层（Harness / Plan / Comm / 知识库）和后端是解耦的。
