# 变更记录 (CHANGES)

> 本文件管理 `skillbot-v2` 分支相对基线 `f5e91d9` 的**所有改动**。
> 顶部为**功能点速览**（一目了然），下方按更新批次记录**详细 diff**。
> 规则：新改动追加在「详细改动」区顶部（倒序，最新在上）；旧记录只标注、不删除。

---

## 一、功能点速览

| # | 功能点 | 状态 | 涉及文件 | 首次记录 |
|---|--------|------|----------|----------|
| 1 | **Plan 模式硬约束**：强制模型先出结构化计划、`code` 留空、本轮禁止调用任何工具（不再直接跳去写代码/探查数据）<br>**⚠️ 2026-08-12 更正**：「本轮禁止调用任何工具」已放宽为**只读语义**（允许 Read/Grep/Glob/LS + 知识库检索，仍禁写入/执行/查数），见功能点 7 | ✅ 已验证(机制)，plan 只读放宽已回归 | `src/agent/prompt.py`、`src/jupyter/magic.py` | 2026-07-30 |
| 2 | **计划生成到 Notebook Cell**：plan 以 `# %%plan` markdown cell 落到 notebook，revise 原地复用同一 cell（不重复堆叠） | ✅ 已验证(机制) | `src/jupyter/magic.py` | 2026-07-30 |
| 3 | **多会话管理**：每个 notebook 独立对话缓冲 + 会话切换栏 + 磁盘持久化；切换 notebook 时重置 LLM 会话记忆（Python 变量仍共享） | ✅ 已移植/已编译 | `panelSessions.ts`、`conversation_store.py`、`magic.py`、`__init__.py`、`panel.ts`、`panelStyles.ts` | 2026-07-30 |
| 4 | **运维/验证脚本**：plan 流确定性冒烟测试、本地/远程 kernel 执行器、跨实例护栏违规查看器 | ✅ 可用 | `scripts/verify_plan_flow.py`、`scripts/kexec.py`、`scripts/rexec.py`、`scripts/violations.py` | 2026-07-30 |
| 5 | **容器 SG Hive 访问打通**：升级 bytedcli 到 0.116（装 `$HOME` 绕只读镜像层），SG `hive search` 走新 endpoint 返回 200 条；根因=容器版本旧（0.79）打废弃 endpoint，非鉴权/权限/legacy token 问题 | ✅ 已实测(容器) | `auth-script.sh`、`SG_HIVE_AUTH_HANDOFF.md` | 2026-08-04 |
| 6 | **明文凭证止血 + .gitignore 加固**：TQS App key 明文（`mB19…/qKVR8…/P2me…/VcNl…`）全部替换为占位符；`.env.*` / `credentials.md` 加入忽略并 `git rm --cached` 停止跟踪；决策方案 1（每人各自申请 TQS App）落 HANDOFF §12/§13 | ✅ 已完成(代码侧) | `intelligent_skills/.gitignore`、`credentials.md`、`.env.sg`、`troubleshooting.md`、`SG_HIVE_AUTH_HANDOFF.md` | 2026-08-04 |
| 7 | **风控知识库 skill + plan 只读放宽**：飞书「风控领域知识库」文档转 MD 封成 skill（纯 MD + Read/Grep 检索、无脚本）；同步放宽 `SECTIONS["plan"]` 为只读语义，让计划生成阶段能参考知识库提升准确度/完整度<br>**⚠️ 2026-08-12 返工**：按更权威的飞书设计文档(docx K2WUdXSlXowyadx1l28mJHVuyTe)重做——采 Anthropic Skills 渐进披露 + Karpathy LLM Wiki 范式，13 篇（补 TTS V4）每篇加 frontmatter(metrics/business_lines/summary)，新增 SCHEMA/index/log/manifest.json 五件套。**skill 名保持 `risk-knowledge-base`**（返工中曾临时命名 `fengkong-kb`，后统一改回，见 F-8）<br>**2026-08-12 收尾**：显式 enable 落盘 + 顶层 `skills/` 与 agent 加载目录双份物理拷贝（比对零差异后）合一为相对软链接，消除分叉风险（见 F-9）<br>**2026-08-13 追加**：知识库「给人看」的可读视图——`scripts/kb_view.py` 产单文件离线 HTML（画廊+阅读页+搜索+SQL 高亮），`%kb_view` line magic 经 iframe srcdoc 隔离内联渲染进 Jupyter（见 F-10）；真机内核+浏览器双路径验证通过，并修复 iframe sandbox 缺 `allow-popups` 致「原文 ↗」新标签页被拦（见 F-10.1） | ✅ 已验证(机制+真机)：prompt 回归 + skill 发现/启用 + manifest 路由 + SQL 不切块 + 13 篇 frontmatter 合规 + 前端实测 + enable 落盘 + 软链接解析 + kb_view 真机内核执行 + 原文链接 popup 修复 | `src/agent/prompt.py`、`skills/risk-knowledge-base/*`、`agents/hermes-agent/skills/.skill_state.json`、`scripts/kb_view.py`、`src/jupyter/magic.py` | 2026-08-12 |

> 状态说明：
> - **已验证(机制)** = 通过确定性测试锁定控制流；**真实 LLM 输出稳定性需真机跑一轮确认**（模型行为不可 100% 保证）。
> - **已移植/已编译** = 代码完成 + tsc 编译产物已生成，功能待 E2E 手测。

---

## 二、详细改动

### 【2026-08-12】更新批次 F — 风控知识库 skill + plan 只读放宽

**背景**：风控相关的**计划生成 / 指标计算**缺少领域口径参考，模型易凭空假设指标定义。需求：把飞书「风控领域知识库」文档转 MD 挂成知识库，并让 plan 模式能参考它。落地设计见 [knowledge_base_draft/DESIGN.md](file:///Users/bytedance/Documents/trae_projects/skillbot/knowledge_base_draft/DESIGN.md)（十节，方案 1 = 独立纯 MD skill + Read/Grep 检索）。

**关键前提更正（用户指出，官方来源）**：Claude Code plan 模式是**只读**而非「禁读文件」——它禁写/禁执行、但允许 Read/Grep 探查。故知识库落地为**纯 MD 目录 + Read/Grep 自然语言检索、不依赖任何可执行脚本**，并据此把批次 A 的「本轮禁止调用任何工具」放宽为只读语义（否则计划阶段读不到知识库，功能失效）。

#### F-1. 新增 `risk-knowledge-base` skill（`skills/risk-knowledge-base/`）
与 `stock-analysis` / `bnpl-rule-set-generator` 布局一致，但**纯知识型、无 `scripts/`**：
- [SKILL.md](file:///Users/bytedance/Documents/trae_projects/skillbot/skills/risk-knowledge-base/SKILL.md)：YAML frontmatter（`name` / 多行 `description` 覆盖内容+触发场景+不触发场景）；正文为**自然语言检索指令**——核心原则（口径以原文为准 / 按需读取 / 计划点名来源 / 不替执行）、4 步检索工作流（INDEX 路由 → 任务映射定向检索 → 指标口径速查 → 生成计划/算指标指引）、已知缺口、边界（BNPL 走 `bnpl-rule-set-generator`）。**不含任何 `.py`**。
- [references/INDEX.md](file:///Users/bytedance/Documents/trae_projects/skillbot/skills/risk-knowledge-base/references/INDEX.md)：12 行机读路由表（类别│相对路径│用途关键词）+ 使用要点（指标以 `PIPO核心指标口径OnePager.md` 原文为准、注意 ROW/EU/US 分区、分子报回日/分母交易日）+ 已知缺口（`[TTS][ROW]电商Payin黑标` 待权限、内嵌图表未离线化、6 个空类别）。
- [README.md](file:///Users/bytedance/Documents/trae_projects/skillbot/skills/risk-knowledge-base/README.md)：三要素（上传物 / 上传路径 / 功能说明）+ 如何被使用 + plan 模式兼容说明 + 更新方式（指向 `scripts/kb_fetch.py`）+ 边界。
- `references/` 下 **12 篇规范化 MD**（从 `knowledge_base_draft/` 迁移，含 `<!-- source_type | doc_id | title -->` 溯源注释）：`01_风控总览/`（PIPO核心指标口径OnePager、CheckPoint列表、3DS2.0分享、国际支付账号体系介绍_GP_Account_System）、`02_业务场景/`（GPP_电商业务线分享_Ecommerce、GPP_TikTokLive业务线分享、GPP_TikTok_LocalService）、`03_风险类型/`（TTS_ROW交易黑标V3、黑白标优化、直播黑白标签定义_D1xBdC、直播黑白标签定义_FalsePositive分析_TTLive）、`04_规则与策略/`（智能规则优化）。**PIPO OnePager 保留完整 SQL（59656 字符，不切块）**。

#### F-2. `src/agent/prompt.py` — `SECTIONS["plan"]` 放宽为只读语义
原第 69 行单条硬规则：
```
- Do NOT run ANY tools this turn — no Bash, no ls/cat, no file reads, no data inspection. If the plan depends on unknown details (columns, schema, file layout), state your assumptions in the plan and add a first step that verifies them AFTER confirmation. Do not verify now.
```
替换为**三条**（[prompt.py L69-77](file:///Users/bytedance/Documents/trae_projects/skillbot/src/agent/prompt.py#L69-L77)）：
1. `This is a READ-ONLY planning turn.` 允许只读工具（Read/Grep/Glob/LS + 知识库检索），但 `MUST NOT write/edit files, execute code, run Bash state-changing commands, or inspect live data`。
2. 涉及风控计划 / 指标 / 规则调优时，`prefer consulting the risk knowledge base first (Read references/INDEX.md → Grep → Read the target file)`，并**注明所依赖指标定义/规则的来源**。
3. 未知细节（列名/schema/文件布局）若知识库未覆盖 → 写进计划的假设，确认后再验证，`Do not run verification queries now`。
- **保留不变**：`plan` 非空、`"code" MUST be an empty array []`（不写用户代码）、确认后才实现。

#### F-3. 验证（design §九，本批次已跑）
- **prompt 回归**（`.venv/bin/python3.12`，因 `str | None` 注解需 3.10+）：`plan_mode=True` 含 `READ-ONLY planning turn` / `MUST NOT write/edit files` / `risk knowledge base` / `references/INDEX.md` / `code:[]`，**不含**旧 `no file reads`；`plan_mode=False` 不含 plan 硬规则 → **PASS**。
- **skill 发现/启用**：`SkillManager('skills').get_skill('risk-knowledge-base')` → 发现、flat 布局默认 `enabled=True`、frontmatter 解析出 `风控`/`PIPO`、正文 2442 字符 → **PASS**。
- **SQL 不切块**：PIPO OnePager 关键 CTE / final join / ATO 用户数 SQL / nonCOD TPV SQL 锚点全在，59656 字符完整 → **PASS**。
- **迁移一致性**：12 篇 MD 与 `knowledge_base_draft/` 源文件 **md5 逐一比对全部 identical**。

#### F-4. 待办
- **skill 部署到 agent 目录（手动、须操作者执行）**：skillbot **无自动同步**，源目录 `skills/` 与 agent 加载目录（`agents/claude-code/.claude/skills/`，当前不存在/为空）是独立副本。部署唯一路径是**停机后**手动 `./scripts/run.sh sync claude-code skills/*`（`cmd_sync` 走 `cp -r`、**会先清空目标目录**）。属改动运行系统的动作，**未擅自执行**。
- **补第 13 篇**：`[TTS][ROW]电商Payin黑标`（lark 3380004 权限不足）待 owner 授权后复跑 [scripts/kb_fetch.py](file:///Users/bytedance/Documents/trae_projects/skillbot/scripts/kb_fetch.py) 补进 `references/03_风险类型/` 并补 INDEX 路由。
- **真机 E2E**：plan 模式下真实 LLM 是否稳定「先只读检索知识库→给出带来源的计划」，属模型行为，需真机跑一轮确认。

#### F-5. 【2026-08-12 返工】改用更权威设计（skill 名保持 `risk-knowledge-base`）

**触发**：用户提供更权威的飞书设计文档 [docx K2WUdXSlXowyadx1l28mJHVuyTe](https://bytedance.my.larkoffice.com/docx/K2WUdXSlXowyadx1l28mJHVuyTe)（合并 Anthropic Agent Skills 渐进披露三层结构 + Karpathy LLM Wiki 持续编译范式，每条主张带官方来源）。评估后采用，并转 MD 覆盖 [knowledge_base_draft/DESIGN.md](file:///Users/bytedance/Documents/trae_projects/skillbot/knowledge_base_draft/DESIGN.md)（旧 v1 草案废弃）。据此对 F-1 的 skill **全量返工**：

- **skill 重建（同名）**：F-1 的旧 `skills/risk-knowledge-base/`（扁平 references 版，从未提交）已 `rm -rf` 删除，按新设计重建为五件套结构的 [skills/risk-knowledge-base/](file:///Users/bytedance/Documents/trae_projects/skillbot/skills/risk-knowledge-base)。返工/部署期间曾临时命名 `fengkong-kb`，后按用户要求统一改回 `risk-knowledge-base`（见 F-8）。
- **源清单勘误（新文档暴露）**：① 旧实现漏了一篇 **`TTS ROW交易黑标V4`**（docx `NdvHda7wdoYg2pxIP3imRObVyKd`），已 lark-cli 补抓；② 旧设计以为"第 13 篇 `[TTS][ROW]电商Payin黑标`卡权限"，实为外链 `D1xBdCDDnoq2lyxLXnjmpPycyvV`——且子 agent 通读后发现其真实标题是 **「EU TTS Payment Risk 黑标V4」**（EU/UK 电商黑标，正文完整），已按实际归档并记 log.md 勘误。
- **13 篇结构化**：每篇按 SCHEMA 加 YAML frontmatter（`category`/`source_url`/`doc_type`/`tags`/**`metrics`**/**`business_lines`**/`summary`/`last_synced`）+ `## 适用场景`/`## 核心概念`/`## 关键指标口径`/`## 规则 / 策略要点` 四摘要节 + `## 原文正文`（**Python 逐字拼接原文、零截断**——PIPO OnePager 62850 字符、含 `app_treasure_channel_rnc_cost_revenue_td` 收尾 SQL 完整）。
- **五件套**：[SKILL.md](file:///Users/bytedance/Documents/trae_projects/skillbot/skills/risk-knowledge-base/SKILL.md)（L1 name+description、L2 检索指南）、[SCHEMA.md](file:///Users/bytedance/Documents/trae_projects/skillbot/skills/risk-knowledge-base/SCHEMA.md)（10 类目定义 + frontmatter 规范 + tags 受控词表）、[index.md](file:///Users/bytedance/Documents/trae_projects/skillbot/skills/risk-knowledge-base/index.md)（分类树 + 一句话摘要路由）、[log.md](file:///Users/bytedance/Documents/trae_projects/skillbot/skills/risk-knowledge-base/log.md)（append-only）、[manifest.json](file:///Users/bytedance/Documents/trae_projects/skillbot/skills/risk-knowledge-base/manifest.json)（13 篇 frontmatter 汇总，供机读过滤）。10 类目目录（4 填充 + 6 空占位加 `.gitkeep`）。
- **prompt.py 同步**：[SECTIONS["plan"]](file:///Users/bytedance/Documents/trae_projects/skillbot/src/agent/prompt.py#L72-L75) 里 KB 检索路径由旧 `references/INDEX.md` 改为 `the risk-knowledge-base skill: Read its index.md / manifest.json → Grep → Read`。
- **验证（design §九，全 PASS）**：prompt 回归（plan 含新只读措辞 + `risk-knowledge-base`/`index.md / manifest.json`、不含旧 `references/INDEX.md`、`code:[]` 保留、默认模式不受影响）；`SkillManager` 发现 `risk-knowledge-base` 且 `enabled=True`、旧扁平 references 版已消失；13 篇 frontmatter 全部 YAML 合规、十字段齐、五节齐（0 issue）；manifest 路由实测（"欺诈资损率"→ PIPO、"直播+标签定义"→ 3 篇）；PIPO SQL 不切块。
- **待办**：`risk-knowledge-base` 同步到 agent 目录仍走手动 `./scripts/run.sh sync claude-code skills/*`（见 F-4，未擅自执行）；真机 E2E 待跑。

#### F-6. 【2026-08-12】部署到 hermes-agent + 前端重启（实测记录）

**背景更正**：F-4/F-5 待办里假设部署目标是 `claude-code`，但用户明确**实际运行的是 `hermes-agent`**。且 `claude-code` 的 `claude` CLI 本机未安装（`command -v claude` 空），`sync claude-code` 被 `check_installed` 挡下（`ERROR: claude not found` / EXIT 1，目标目录未被触碰）。故改按 hermes-agent 部署。

**同步三步（停机→同步→重启，用户经 AskUserQuestion 确认）**：
1. **停机** `./scripts/run.sh stop hermes-agent`：旧进程 pid 30770 已终止、`.run/hermes-agent.pid` 已清除（沙箱对 `kill` 收尾报 "failed in sandbox"，但停机本身生效——`kill -0 30770` 返回 DEAD、`pgrep` 无匹配）。
2. **同步** `./scripts/run.sh sync hermes-agent skills/*`（EXIT 0）：`skills/` → `agents/hermes-agent/skills/custom/`（`cmd_sync` 先 `rm -rf 目标/*` 再 `cp -r`）。拷入 5 个 skill：`bnpl-rule-set-generator` / **`risk-knowledge-base`** / `gain-discovery` / `stock-analysis` / `stock-data-fetch`。
3. **重启** `./scripts/run.sh start hermes-agent`（EXIT 0）：新 gateway pid 33254，model `deepseek/deepseek-v4-flash`，启动 `[STATUS]` 已列出 `risk-knowledge-base`。

**验证（全 PASS）**：
- 目标目录 `risk-knowledge-base` 文件齐全：五件套 + 13 篇 reference + 10 类目目录 = 17 个 `.md` + `manifest.json`（11094 字节）。
- `SkillManager('agents/hermes-agent/skills/custom')` 直查：`risk-knowledge-base` **found=True / enabled=True**；description 正确加载（风控知识库触发场景）。**注意**：hermes 是 categorized 布局（默认只启用 `software-development` 类目），但 `skills/*` 是把各 skill **扁平铺进 `custom/` 顶层**，`_is_categorized()` 判为 flat → 全部默认启用，故 `risk-knowledge-base` 生效无需额外配置。

**前端（webui）重启——发现 run.sh 两处缺陷**：
- hermes 前端 = webui（端口 5174）+ dashboard 后端（9119）。原 `_start_webui` 用 `nohup npm run start` 启动，实测**从未成功**：① nohup 子 shell 无 nvm 的 PATH → `nohup: npm: No such file or directory`；② `web/package.json` **无 `start` 脚本**（只有 `dev`/`build`/`preview`），且 `vite` 是 npm workspace 二进制，装在 hermes-agent 根 `node_modules/.bin/vite`、不在 `web/` 子目录，`web` 下 `npm run dev` 报 `vite: command not found`（EXIT 127）。
- **实际生效路径**：`hermes dashboard --no-open`（端口 9119）启动时会**自行 `vite build` 并内嵌托管最新 Web UI**（日志 `✓ Web UI built` / `HERMES_DASHBOARD_READY port=9119`）。手动带 nvm PATH 启动 dashboard 后，`curl http://localhost:9119/` 返回 **HTTP 200**——**前端已重启生效**（服务的是刚同步、含 risk-knowledge-base 的最新构建）。独立 :5174 vite dev server 非本部署实际前端，失败进程已自行退出（无残留）。
- **最终存活**：gateway pid 33254 + dashboard/前端 :9119 pid 34821。
- **遗留建议**（非本次改动，供后续修 run.sh）：`_start_webui` 对 hermes-agent 应改为 `npm run dev`（或直接依赖 dashboard 内嵌前端）并在启动前注入 nvm PATH，否则 `[WARN] webui start pending` 会长期是"假启动"。

#### F-7. 【2026-08-12】修复 run.sh webui 假启动 + 浏览器实测 risk-knowledge-base 生效

**修 [scripts/run.sh](file:///Users/bytedance/Documents/trae_projects/skillbot/scripts/run.sh)（承接 F-6 遗留建议）**：
- **新增 `_ensure_node_on_path()`**：`start`/`sync` 跑在非登录 shell，nvm 的 shim 未 source → `nohup npm ...` 报 `npm: No such file or directory`。helper 在 npm 缺失时 source `${NVM_DIR:-~/.nvm}/nvm.sh` 并 `nvm use default`（**跟随 nvm alias、不硬编码版本号**，当前 default=22→v22.23.1）。隔离实测：最小 PATH 下 npm 由 NONE → 定位到 nvm npm 10.9.8。
- **重写 `_start_webui()` 的 hermes-agent 分支**：原逻辑 `nohup npm run start` **从来是假启动**（`web` 无 `start` 脚本、vite 在 workspace 根不在 `web/`）。改为——hermes 的 **dashboard 即前端**（`hermes dashboard --no-open` 自行 `vite build` 并托管 Web UI 于 :9119），起好后上报 `http://localhost:9119` 并 `return 0`，**不再尝试无用的 :5174 vite dev**；启动等待改为最多 15s 轮询探测端口；依赖检查后统一调 `_ensure_node_on_path`（dashboard 的 vite build 也需 node）。
- `bash -n` 语法校验通过。

**全链路重启实测**：`stop`（gateway 30770/临时 dashboard 全清）→ `start hermes-agent`（EXIT 0，新 gateway pid 40086，dashboard 由 gateway 自动带起于 :9119、由子进程 39950 持有，`_start_webui` 命中"already running"幂等分支）。`curl http://localhost:9119/` → **HTTP 200**。

**浏览器端验证（TRAE-browseruse，最权威的"真机"确认）**：打开 `http://localhost:9119` → Dashboard 正常渲染 → Skills 页显示 **"104/104 enabled"** → 左侧 CATEGORIES 过滤 **Custom(3)** → **`risk-knowledge-base` 排第一、启用开关为 on、中文 description 正确渲染**（"风控领域知识库。当任务涉及风控计划生成、风控指标计算与口径查询、风险标签/…"）。**risk-knowledge-base 已在 hermes-agent 前端生效。**

#### F-8. 【2026-08-12】skill 更名收尾：`fengkong-kb` → `risk-knowledge-base`

**背景**：返工/部署期间 skill 曾临时命名 `fengkong-kb`，用户决定统一改回设计文档里的正式名 `risk-knowledge-base`。为避免读者混淆，F-5/F-6/F-7 正文里原先记录为 `fengkong-kb` 的**同一 skill 实体/路径引用一并回填为 `risk-knowledge-base`**；仅 F-5 首条与功能点 7 保留"曾临时命名 fengkong-kb"的说明性标注，以留痕更名事实（遵循"保留历史 + 追加标注"惯例）。

**改动清单**：
- **目录**：`skills/fengkong-kb/` → [skills/risk-knowledge-base/](file:///Users/bytedance/Documents/trae_projects/skillbot/skills/risk-knowledge-base)（`mv`，目录未被 git 跟踪）。
- **[SKILL.md](file:///Users/bytedance/Documents/trae_projects/skillbot/skills/risk-knowledge-base/SKILL.md)**：`name: fengkong-kb` → `name: risk-knowledge-base`（description 不变）。
- **[log.md](file:///Users/bytedance/Documents/trae_projects/skillbot/skills/risk-knowledge-base/log.md)**：初始化行改名 + append 一条更名记录（append-only）。
- **[src/agent/prompt.py](file:///Users/bytedance/Documents/trae_projects/skillbot/src/agent/prompt.py#L73)**：`SECTIONS["plan"]` 里 KB 检索引导的 skill 名改为 `risk-knowledge-base`（只读语义不变）。
- **[knowledge_base_draft/DESIGN.md](file:///Users/bytedance/Documents/trae_projects/skillbot/knowledge_base_draft/DESIGN.md)**：5 处（目录树 / 落盘位置 / SKILL name / 阶段 0 建目录 / 阶段 3 挂载）全部改名。
- **[CHANGES.md](file:///Users/bytedance/Documents/trae_projects/skillbot/CHANGES.md)**：功能点 7 + F-5/F-6/F-7 正文里指向 skill 实体/路径的引用全部改名（本条 F-8 记录更名事实）。
- **说明**：`index.md`/`manifest.json`/`SCHEMA.md` 及 13 篇 reference 内部均用**相对路径、不含 skill 名**，无需改。

**重新部署 + 真机复验（全 PASS）**：
- 停机（沙箱对 `kill` 报 "failed in sandbox"，但 pid 40086/dashboard 均 DEAD、9119 释放、pid 文件清除，停机生效）→ `sync hermes-agent skills/*`（EXIT 0，`cmd_sync` 先清空 `custom/` 再 `cp -r`，结果列出 `risk-knowledge-base`，旧 `fengkong-kb` 副本随之消失）。
- **发现运行时真实加载目录是 `~/.hermes/skills/custom/`（HERMES_HOME），非 run.sh sync 的 `agents/hermes-agent/skills/custom/`**：`~/.hermes/skills/custom/` 里同时残留旧 `fengkong-kb`（建设期副本）与新 `risk-knowledge-base`，导致 dashboard 仍显示 "Edit fengkong-kb"。已 `rm -rf ~/.hermes/skills/custom/fengkong-kb`（同一 skill 旧名副本，`name: fengkong-kb`、description/结构一致，删除安全），`.bundled_manifest` 无 fengkong 残留。
- **gateway 起不来的原因**：本会话沙箱拦截 run.sh nohup/后台派生进程写 `~/.hermes/logs/agent.log`、`~/.hermes/gateway.lock`（`PermissionError [Errno 1] Operation not permitted`）；同一命令在当前 shell 内联 `&` 起则 clean（无报错，存活正常），证实是**沙箱对分离进程的写入限制，与重命名/代码无关**。dashboard 前端不写这些文件，可正常启动。
- **dashboard 前端**（`hermes dashboard --no-open`，需 source nvm 让 npm 可用以 `vite build`）起于 :9119、`HERMES_DASHBOARD_READY`、`curl` HTTP 200。
- **浏览器实测**（TRAE-browseruse）：Skills 页 **"104/104 enabled"**（原 105 减去删掉的旧 fengkong-kb）→ CATEGORIES 过滤 **Custom(3)** → **`risk-knowledge-base` 排第一、开关 on、中文 description 正确渲染**；stock-analysis / stock-data-fetch 亦 on。**旧 "Edit fengkong-kb" 已消失，全链路 `fengkong-kb` → `risk-knowledge-base` 生效。**

#### F-9. 【2026-08-12】显式 enable skill + 双份物理拷贝合一为软链接

**背景**：用户询问「实际用 agent 时如何确定会走这个知识库」。核对链路（[chat/__init__.py](file:///Users/bytedance/Documents/trae_projects/skillbot/src/chat/__init__.py#L92-L134) `_maybe_inject_skills` → [skill.py](file:///Users/bytedance/Documents/trae_projects/skillbot/src/chat/skill.py#L345-L379) `inject_prompt`）确认：**无 `/` 点名调用语法**——`/skills` 仅管理（开关/查看）；只要 skill 处于 **enabled**，其 SKILL.md 正文会在会话首条消息自动注入，模型再按 `description` 自行判断相关性。

- **enable 落盘**：经与面板同路径的 `SkillManager(_resolve_skill_dir('hermes-agent')).enable('risk-knowledge-base')` 启用，写入 [.skill_state.json](file:///Users/bytedance/Documents/trae_projects/skillbot/agents/hermes-agent/skills/.skill_state.json)（`enabled: ["risk-knowledge-base"]`）；重新从磁盘加载后 `active_skills` 含 `risk-knowledge-base` → 生效且持久化。
  > **诚实备注**：本次 `enable()` 探测时 `before=True`，说明启用态在更早环节已落盘，本次实为**幂等重复**而非首次翻转；最终状态确定正确（enabled）。
  > **机制说明**：hermes 的 `custom/` 是扁平铺放 → `_is_categorized()` 判为 flat 时全部默认启用；但纯默认策略下（无 state 文件）曾观测到 `custom` 分类 skill 默认 `enabled=False`，故以**显式 enable + state 文件**锁定，避免依赖默认策略的边界行为。

- **双份合一**：发现 `risk-knowledge-base` 存在两处物理拷贝——顶层 `skills/risk-knowledge-base/`（用户在 IDE 打开的）与 agent 实际加载的 `agents/hermes-agent/skills/custom/risk-knowledge-base/`。
  - **先比对后动手**：`diff -rq` 两目录 `exit=0` 无差异输出；逐文件 SHA-256 交叉比对，**24 个文件哈希逐一相同**（含 6 个空 `.gitkeep` 均为空文件标准哈希 `e3b0c442…`）→ 内容零差异，替换安全。
  - **合一**：`rm -rf skills/risk-knowledge-base` 后建**相对软链接** `skills/risk-knowledge-base -> ../agents/hermes-agent/skills/custom/risk-knowledge-base`（相对路径利于仓库迁移）。验证：`readlink -f` 正确解析到 agent 下真实目录、透过链接可读出 `name: risk-knowledge-base`、目标实体完好。
  - **效果**：唯一物理实体在 agents 下（agent 实际加载处），顶层仅软链接指向，消除「改一份另一份不同步」的分叉风险；不影响任何现有加载逻辑。

#### F-10. 【2026-08-13】知识库「给人看」的可读视图 + `%kb_view` magic

**背景**：`risk-knowledge-base` 目前是给模型检索的纯 MD（渐进披露），但**人**要浏览具体内容只能逐个翻文件。用户要求在 agent 里做一个「人看的视图」——能直接看到 13 篇的标题/摘要/标签/正文，参考 MagiBook 风格的画廊 + 阅读页。

- **新增 [scripts/kb_view.py](file:///Users/bytedance/Documents/trae_projects/skillbot/scripts/kb_view.py)**：读 `skills/risk-knowledge-base/manifest.json` + 13 篇 MD，产出**单文件离线 HTML**（内嵌 CSS/JS，零网络请求）。特性——左侧类别树（镜像 `NN_<类别>` 目录，含 6 个空占位）、MagiBook 风卡片画廊（标题/摘要/`doc_type` 徽章/标签）、点卡进阅读页（含指标/来源原文链接）、顶栏按标题+标签+摘要即时搜索、正文 SQL/代码经 pygments(monokai) 语法高亮。**零新增依赖**：复用已 vendored 的 mistune + pygments + stdlib。可 `--out` 存盘直接浏览器打开，或嵌 Jupyter。
- **新增 `%kb_view` line magic**（[src/jupyter/magic.py](file:///Users/bytedance/Documents/trae_projects/skillbot/src/jupyter/magic.py#L1449-L1494)）：`%kb_view [--height N] [--save PATH]`。经 `importlib` 懒加载 `scripts/kb_view.py`（非包，按需构建，避免拖慢 kernel 启动）→ `build_html()` → 用 `html.escape` 后塞进 `<iframe srcdoc=... sandbox="allow-scripts">` **inline 渲染**。用 iframe srcdoc 隔离是关键：知识库的全局 CSS（`body`/`*` 选择器）不会泄漏污染 notebook DOM。`--save` 可另存独立 HTML，`--height` 调高度（默认 820px）。模块级 helper `_build_kb_view_html()`（[magic.py L180-195](file:///Users/bytedance/Documents/trae_projects/skillbot/src/jupyter/magic.py#L180-L195)）+ 顶部新增 `import html`。
- **用法**：skillbot 内核里执行 `%kb_view` 即在 cell 下方内联出画廊；`%kb_view --save /tmp/kb.html` 另存后可浏览器打开。
- **验证**：`ast.parse` 语法校验 magic.py PASS；`build_html()` 冒烟——输出 466KB HTML、含 monokai `.highlight` 样式；`html.escape(doc, quote=True)` 后 srcdoc 内**零裸双引号**（不会截断 iframe 属性）；`_build_kb_view_html` 路径解析（`magic.py` → `parents[2]/scripts/kb_view.py`）实测命中真实文件。**待真机**：Jupyter cell 内 iframe 实际渲染 + 搜索/切类/阅读交互手测。
- **【2026-08-13 真机验证补记】**：上述「待真机」已闭环。走**双路径交叉验证**——(1) `nbconvert --execute` 用真实 **skillbot 内核**（内核 `bootstrap.py` 从 `src/` 加载扩展，与线上同路径）跑 `kb_view_verify.ipynb`：`exit=0`、零报错、`%kb_view` 产出合法 `<iframe srcdoc=...>`（651KB，仅一条无害 IPython「建议用 IFrame」warning）；(2) 浏览器打开 iframe 内嵌 HTML 截图核对——顶栏「风控知识库」+搜索框、左侧类别树（全部13/风控总览4/…含空占位）、卡片网格、点卡进阅读页（返回按钮+原文链接+正文）全部 PASS；body 内实测 **4 个** `<div class="highlight">` SQL 块（`#272822` monokai 背景、`<span class="k">select</span>` 着色）；搜索 `addEventListener('input')` 读 `data-search` 过滤逻辑经源码核对正确（浏览器自动化工具无法触发 JS input 事件，属工具局限非缺陷）。

##### F-10.1 【2026-08-13】修复：阅读页「原文 ↗」链接点击无反应

**现象**：用户在 Jupyter 里点阅读页的「原文 · docx ↗」没反应，怀疑没生成飞书链接。
- **排查**：manifest 里 13 篇 `source_url` 全是完整飞书 https 绝对 URL，渲染出的 `<a>` 也都带 `target="_blank" rel="noopener"`（[kb_view.py L171-176](file:///Users/bytedance/Documents/trae_projects/skillbot/scripts/kb_view.py#L171-L176)）——**链接标记完全正确**。
- **根因**：iframe 的 `sandbox="allow-scripts"` 只放行了 JS，**未给 `allow-popups`**。浏览器 sandbox 规则下 `target="_blank"` 新开标签页属 popup 行为，缺权限被**静默拦截** → 表现为「点了没反应」。之前浏览器验证是直开 `file://` 裸 HTML（无 sandbox）故未暴露，只有在 Jupyter sandbox iframe 里才复现。
- **修复**（[magic.py L1490-1500](file:///Users/bytedance/Documents/trae_projects/skillbot/src/jupyter/magic.py#L1490-L1500)）：sandbox 改为 `allow-scripts allow-popups allow-popups-to-escape-sandbox`——`allow-popups` 放行新标签页，`-to-escape-sandbox` 让新开的飞书页不继承 sandbox 限制、能正常加载。仅加这三项（不加 `allow-same-origin`），CSS 隔离不受影响。
- **验证**：`ast.parse` PASS；真机 skillbot 内核重跑 `%kb_view`，输出 iframe 已带 `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"`；13 个 src-link 全为绝对 https + `target="_blank"`。**需用户操作**：浏览器 hard refresh（Cmd+Shift+R）+ 重启 kernel 重跑 `%kb_view` 后，点「原文 ↗」即新开标签页跳飞书原文。

---

### 【2026-08-04】更新批次 E — 明文凭证止血 + .gitignore 加固 + 方案 1 落定

**背景**：方案 1（每人各自申请 TQS App）落地的前提是停用/轮换历史共享 App，而这些 key 已在多处明文暴露。本批次做**代码侧止血**（明文→占位符 + 停止 git 跟踪 + 补 .gitignore）。真正作废旧 key / 发新 key 仍需去 TQS 平台操作（代码无法代劳）。

#### E-1. 明文密钥替换为占位符
经精确值扫描（排除 `.git`/`.venv`/`node_modules`），命中 4 个真实 key 值的工作区文件全部脱敏：

| 文件 | 原明文 | 处理 |
|---|---|---|
| `intelligent_skills/configuration/credential/credentials.md` | `mB19…`/`qKVR8…`（多处） | → `your_tqs_app_id_here`/`your_tqs_app_key_here` + 顶部加安全更正标注 |
| `intelligent_skills/skills/sample_analysis/references/troubleshooting.md` | `mB19…`/`qKVR8…` | → 占位符 |
| `intelligent_skills/scripts/environments/.env.sg` | `P2me…`/`VcNl…`（**活凭证，风险最高**） | → `your_sg_app_id_here`/`your_sg_app_key_here` + 加注 |
| `skillbot搭建进度与待办.md`（顶层，非 repo） | `mB19…`（报错/表格 2 处） | → 截断为 `mB19…RYriL9` + 脱敏标注 |

- 收尾扫描 `grep -rE "mB19…|qKVR8…|P2me…|VcNl…"` → **✅ 工作区无任何真实 key 残留**。
- `.env.eu` 本就是占位符（`your_eu_app_id_here`），未改内容。

#### E-2. .gitignore 加固 + 停止跟踪
- **发现**：`intelligent_skills/.gitignore` 原本**没有** `.env` 规则（只有一条 `!.env.example` 反向豁免），且 `.env.sg`（活凭证）/`.env.eu`/`credentials.md` **均已被 git 跟踪**。
- **加规则**（[.gitignore](file:///Users/bytedance/Documents/trae_projects/intelligent_skills/.gitignore#L11-L22)）：`.env` / `.env.*` / `scripts/environments/.env.*`（保留 `!.env.example`）+ `**/credentials.md` + `*.key`/`*.pem`。
- **停止跟踪**（保留工作区文件，仅从索引移除）：
  ```
  git rm --cached scripts/environments/.env.sg scripts/environments/.env.eu configuration/credential/credentials.md
  # check-ignore 验证：.env.sg → 命中 .gitignore:15；credentials.md → 命中 :20
  ```
- **注意**：这些文件的**历史提交仍含明文**——`git rm --cached` 只停未来跟踪，不清历史。彻底清除需 `git filter-repo`/BFG（**未执行**，留待决策，见 §9）。

#### E-3. 方案 1 决策落文档
- HANDOFF 新增 [§12 查证收敛](file:///Users/bytedance/Documents/trae_projects/SG_HIVE_AUTH_HANDOFF.md#L237-L254)（三路径表 + tqs 只能 App 身份的代码级铁证 + spark_sql 死路 + ✅ 方案 1 决策）与 [§13 申请指引](file:///Users/bytedance/Documents/trae_projects/SG_HIVE_AUTH_HANDOFF.md#L258-L308)（super_app_apply 入口 / 集群 sg_row / 库表授权 / 注入 / 验证 / profile）。

#### E-4. 待办（用户侧，代码无法代劳）
- **TQS 平台**：作废/停用共享 App `mB19…`（`pipo_bigdata_analysis`）、`P2me…`（`pipo_bigdata_analysis_mrt`）；各人自行 super_app_apply 申请本人 App。
- **git 历史清理**（可选）：明文仍在两个 repo 的历史提交中，如需彻底清除走 filter-repo（破坏性、需协调协作者，暂缓）。

---

### 【2026-08-04】更新批次 D — 容器 SG Hive 访问打通（bytedcli 升级）

**背景**：skillbot 容器需以「用户各自身份」查 SG hive 表。容器旧 bytedcli 0.79 报 `CoralNG API error: 用户未登录`，一度误判为 legacy SSO token 缺失 / 权限 / emp-proxy 出站问题（详见 [SG_HIVE_AUTH_HANDOFF.md](file:///Users/bytedance/Documents/trae_projects/SG_HIVE_AUTH_HANDOFF.md) §4 走过的弯路）。对照实验（同账号 muruotong.01、同命令，Mac 0.116 ✅ vs 容器 0.79 ✗）钉死根因：**版本旧 → 打废弃 SG endpoint（`dataleap-sg.bytedance.net/new_coralng_alisg_api`），SG 已不接受该旧鉴权**。

#### D-1. 根因确认 + 升级方案（EROFS 更正）
- **原计划**（HANDOFF §6/§7）：在 `/home/tiger/local/bytedcli` 原地 `npm install` 升级。**实测行不通** —— 该目录在只读镜像层：
  ```
  npm error code EROFS: read-only file system, rename '/home/tiger/local/bytedcli/node_modules/...'
  ```
- **可行方案**：装到可写的 `$HOME` 下，不动只读层；auth 态仍在 `$HOME/.bytedcli`，用户身份透传不受影响：
  ```bash
  mkdir -p ~/bytedcli-latest && cd ~/bytedcli-latest \
    && npm install @bytedance-dev/bytedcli@latest --registry=https://bnpm.byted.org
  # → added 342 packages；~/bytedcli-latest/node_modules/.bin/bytedcli --version → 0.116.0
  ```

#### D-2. 原始实测验证记录（容器 JupyterLab 终端）
- ✅ **`hive search`（元数据，方案 b 各人身份）通**：
  ```
  $ ~/bytedcli-latest/node_modules/.bin/bytedcli --site i18n-tt hive search --query test -r sg
  DataLeap Search: "test" (HiveDB)  ...  (Location 全为 hdfs://harunasg，SG 机房)
  Total: 200 (page 1 size 20)
  ```
  与 Mac 0.116 对照组结果一致 → **根因 = 版本旧，与 legacy SSO token / 权限 / auth-script.sh 均无关**。新版复用现有 ByteCloud session 即可查 SG，**无需 export/import、无需 legacy token**（顺带证明方案 b 可只靠 ByteCloud session 成立）。
- ⛔ **`tqs execute`（查数据，方案 a 服务账号）卡在凭证**：
  ```
  $ ~/bytedcli-latest/node_modules/.bin/bytedcli --site i18n-tt tqs execute --cluster sg --sql "select 1"
  ✗ 缺少 TQS AppID 凭证，请设置环境变量 TQS_APP_ID，或者在 .env 文件中配置
  ```
  pre-flight 缺凭证即退出，**未走到网络层 → 4005 出站墙对 tqs 仍未验**。tqs 依赖服务账号 `TQS_APP_ID/KEY`（方案 a），与用户目标（方案 b 各人身份）冲突，是否启用留待产品决策；且 HANDOFF §9 要求旧凭证轮换，本次**未设置**任何凭证。
  > **【2026-08-04 更正 ✅ 已验通】** 注入正确 App 后 tqs **在 Mac 与容器均跑通** `select 1`（`status: Completed, sample_data: [['1']]`）。定位到本机有两套凭证：`.env.sg` 的 `P2me…`(cluster `sg_row`) = **有权限**；`~/.zshrc` 的 `mB19…` = 未授权错 App（`code:110 doesn't have access`）。容器结果走 `tqs-sg-dl.byteintl.net`（生产网），**4005 未撞，§8 无需启动**。详见 HANDOFF §12。**遗留**：`P2me…` 是能用的凭证且已多处明文暴露 → 泄露等级最高，须轮换（§9）；方案 a/b 归属待决策。

#### D-3. 待办
- 交付固化：更新 [auth-script.sh](file:///Users/bytedance/Documents/trae_projects/auth-script.sh)，加「`$HOME` 安装最新 bytedcli + 指向新 bin」，绕开只读层（本批次下一步）。
  > **【2026-08-04 已完成 ✅】** auth-script.sh 已加 `ensure_latest_bytedcli`（步骤 1/3），装到 `$HOME/bytedcli-latest` 绕 EROFS，已装则跳过、npm 缺失/失败回退 PATH 旧版并告警；登录/status/示例改用解析出的 `$BYTEDCLI`。**交付形态已定：每用户各自容器跑一次此脚本即可，不改镜像**（免动镜像构建；代价是每人首次 ~5min npm，可接受）。
- **查数「各人身份」路径查证 + 方案定稿**【2026-08-04】：三路径查清——hive=真·人身份(仅元数据)✅；**tqs 代码级确认只能 App 身份**（`loadTqsCredentialsFromEnv` 无条件要 appId/appKey，`--as` 不影响 tqs，鉴权头 `X-TQS-AppID/AppKey` 明文，login 仅填 `user` 字段）；spark_sql 死路（已移除+集群 3.2 不支持 Connect，认证也是 LDAP/Kerberos 非 SSO）。**决策：方案 1 = tqs 每人各自申请一个 App**（key 不共享，本质仍 App 身份属妥协）。落地指引见 HANDOFF §12/§13。
- 若后续走 tqs：需先解方案 a/b 凭证冲突 + 验 4005（§8 备用方案）。
  > **【2026-08-04 更新 ✅】** 4005 已验证**未撞**（tqs 走生产网 `byteintl.net`）；凭证冲突已决策为方案 1（各人各自 App，HANDOFF §13）。

---

### 【2026-07-30】更新批次 A — Plan 模式硬约束 + 计划落 cell

**背景**：plan 模式下模型常直接给代码/探查命令（`ls`），而非先出计划。根因是 plan 约束只是软提示，且 `plan` 字段常为空。

#### A-1. `src/agent/prompt.py`（+11 / -5）
重写 `SECTIONS["plan"]`，从「软建议」升级为「硬规则」：
- `plan` 字段**必须非空**（完整分步计划，markdown）。
- `code` 字段**必须是空数组 `[]`**，本轮不许写任何用户代码。
- **本轮禁止调用任何工具**（Bash / ls / cat / 读文件 / 数据探查）；若计划依赖未知细节（列名/schema），在计划里写明假设，并把「验证」作为**确认后**的第一步。
- 计划需覆盖：数据加载、具体步骤/实验、模型与超参、指标、最终交付物。
- revise 时仍输出非空 `plan` 且保持 `code: []`。

#### A-2. `src/jupyter/magic.py`（plan 相关部分）
- **import**（line 14）：`from agent.prompt import PromptBuilder` → `PromptBuilder, SECTIONS`。
- **首轮 plan 前缀**（`_handle_panel_prompt`, ~L689-696）：软前缀替换为复用 `SECTIONS["plan"]` 的硬约束。
  > 架构注：系统提示是**会话级**一次性构建，不能翻 `_merge_prompt(plan_mode=True)`（会让每个请求都变 plan）。改为**请求级**注入，只有 plan 请求带硬约束。
- **首轮 plan 落 cell**（~L718-721）：`plan_text` 解析后调用 `self._emit_plan_cell(plan_text)`。
- **revise 分支**（`_handle_panel_confirm` else 支, ~L1157-1178）：
  - revise prompt 同样注入 `SECTIONS["plan"]` 硬约束。
  - **修复 bug**：revise 后新增 `self._last_plan_result = result` 刷新缓存——原来确认时会执行**旧计划**。
  - revise 后调用 `self._emit_plan_cell(plan_text)`（原地更新同 cell）。
- **新增方法 `_emit_plan_cell`**（~L1258-1272）：把计划渲染成 `# %%plan\n\n<plan>` 的 **markdown cell**（复用 `render.render_code(cell_type="markdown")`）；用 `replace_cell_id=self._plan_cell_id` 实现 revise 原地更新；回调把 cell id 存进 `self._plan_cell_id` 和 `user_ns["__plan_cell_id__"]`。
- **`_implement_plan`**（~L1274-1282）：确认执行时 `result.plan = ""`，避免 `render_output` 再画一遍计划 cell（防重复）。
- **新增字段**（`__init__`）：`self._plan_cell_id = ""`（当前计划 cell 的 id）。
- **确认/取消清理**（`_handle_panel_confirm` yes/accept_edits/no 支）：三处补 `self._plan_cell_id = ""`（确认后保留 cell 在 notebook，下一次 plan 从新 cell 开始）。

#### A-3. `scripts/verify_plan_flow.py`（新增，151 行）
确定性冒烟测试（mock LLM，不发真实请求），锁定 plan 流控制流。**13/13 全 PASS**，验证：
- 硬约束注入 prompt、含「禁止本轮调用工具」；
- 计划以 markdown cell 发出（`# %%plan` 开头、首轮新建 replace_id 为空）；
- 发 `plan_confirm`、状态进入 `PLAN_REVIEW`、cell id 被记住；
- revise 复用同一 cell id（原地更新）、revise 重新注入硬约束、新计划文本进入。

> **诚实边界**：本测试证明「代码控制的部分」是稳的；「真实模型是否总先给计划」是模型行为属性，只能真机验证。配合 prompt 里显式加「先只给计划不写代码」为双保险。

---

### 【2026-07-30】更新批次 B — 多会话管理移植

**背景**：从旧分支 `feature/bottleneck1-progressive-skill-loading` 移植多会话能力到纯净的 `skillbot-v2`，严格遵守「其他实验模块（panelSteps/panelSkills）不带过来」。

#### B-1. `src/jupyter/extension/src/panelSessions.ts`（新增，329 行）
会话管理 + 持久化前端模块（所有函数以 `panel: any` 为首参）。核心：`storageKey`、`saveState`（localStorage + 经 `_panel_save_conversation` 落盘）、`restoreState`、`loadBuffer`（本地无缓存时经 `_panel_load_conversation` 请求磁盘副本）、`applyBuffer`、`loadRegistry`/`saveRegistry`、`registerSession`、`switchToSession`、`openNotebook`、`newSession`（新建 Untitled.ipynb）、`renameSession`、`deleteSession`、`purgeSession`、`onNotebookFileDeleted`、`renderSessionBar`。常量：`STORAGE_PREFIX`、`REGISTRY_KEY`、`COLLAPSE_KEY`。

#### B-2. `src/jupyter/conversation_store.py`（新增，100 行）
磁盘持久化后端（自包含，无外部依赖）。API：`save_conversation` / `load_conversation` / `list_conversations` / `delete_conversation`。存到 `.run/conversations/`，按 `md5(nb_path)[:12]` 作键。已冒烟测试通过。

#### B-3. `src/jupyter/magic.py`（多会话部分，+桥接函数）
- **5 个模块级桥接函数**（~L127-172）：`_panel_save_conversation`、`_panel_load_conversation`（emit `restore_conversation`）、`_panel_list_conversations`（emit `conversation_list`）、`_panel_delete_conversation`、`_panel_switch_notebook`（调 `inst._handle_notebook_switch`）。
- **新增方法 `_handle_notebook_switch`**（~L519-551）：切换 notebook 时重置 LLM 会话（`_session.cleanup()` + `_session_ready=False` 懒重建 + `_session_dirty=False`）；守卫「路径相同不重置 / 首次绑定不重置 / session 未 ready 不重置 / 任务运行中不重置」。Python namespace 共享不动。
- **新增字段**（`__init__`）：`self._session_nb_path = None`。

#### B-4. `src/jupyter/__init__.py`（+16 / -1）
`load_ipython_extension` 中 import 改多行，新增 5 个桥接函数并逐个注入 `ipython.user_ns[...]`，供前端经 `get_ipython().user_ns[...]` 调用。

#### B-5. `src/jupyter/extension/src/panel.ts`（+201 / -18）
主类接线（14 处多会话标记）：`import * as SS from './panelSessions'`；新增字段 `_currentPath` / `_sessionBarEl` / `_sessionsCollapsed` / `_app`；委托方法块（`_saveState`/`_restoreState`/`_loadBuffer`/... → `SS.*`）；`setApp`/`setActivePath`/`notifyNotebookSwitch`/`onNotebookFileDeleted`；comm 新增 `restore_conversation`、`conversation_list` 两个 case；comm.open 后拉取 `_panel_list_conversations()`；插件 activate 里接 `setActivePath`、notebook 切换/删除监听。

#### B-6. `src/jupyter/extension/src/panelStyles.ts`（+224）
新增 31 处 `.skillbot-session-*` CSS（session-bar / header / chevron / list / row / dot / edit / del + hover/active/collapsed 变体），复用已有 CC 主题常量。

#### B-7. 编译产物（tsc 生成）
`lib/panel.js`、`lib/panelStyles.js`、`lib/panelSessions.js`(+`.d.ts`)、`tsconfig.tsbuildinfo`。已验证含 session 代码、无 panelSteps/panelSkills。

> **已知独立问题**（非本次改动引入）：部分 notebook 连的是 `python3` 内核而非 `skillbot`，会导致 Agent 面板卡 `Thinking`（python3 内核无 `_panel_input`）。用 Agent 面板须确认 notebook 内核为 skillbot。`newSession` 目前未显式指定 kernel（待定是否修）。

---

### 【2026-07-30】更新批次 C — 运维/验证脚本

| 脚本 | 行数 | 作用 |
|------|------|------|
| `scripts/verify_plan_flow.py` | 151 | plan 流确定性冒烟测试（见 A-3） |
| `scripts/kexec.py` | 42 | 通过连接文件在**本地** live kernel 执行代码，打印 stdout/stderr/结果 |
| `scripts/rexec.py` | 80 | 通过 websocket API 在**远程** kernel 执行代码（kexec 的远程版），只读验证部署行为 |
| `scripts/violations.py` | 148 | 跨实例护栏违规查看器：读 `.run/guardrail/*.jsonl`（每端口/用户一份），运维侧一次看全 |

---

## 三、验证状态汇总（截至 2026-07-30）

- `py_compile`：`magic.py` / `prompt.py` 通过。
- `pytest tests/jupyter tests/agent`：**129 passed**；5 failed 为基线 `f5e91d9` 上**预存在**失败（`test_render.py` 的 `trace` kwarg ×3、`test_parser.py` 的 code-fence ×2），`git diff` 证明相关文件未被本次改动触碰。
- `verify_plan_flow.py`：**13/13 PASS**。
- tsc 全量编译：exit 0，lib 产物含 session、无实验模块。
- **待真机 E2E**：plan 模式真实 LLM 是否稳定先出计划；多会话切换/持久化 UI 实测。
