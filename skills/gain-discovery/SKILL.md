---
name: gain-discovery
description: |
  当用户要在带特征的风控样本上「找增益方向」时使用本技能：自动找出当前模型漏过的黑样本聚集在哪，
  衍生候选交叉/比值特征，用真训练量化每个特征的增益（Δrecall@precision），输出带证据的 Top-N
  候选方向与决策选项（decision_gate）。

  本技能只给「值得验证的方向 + 量化预估」，不下最终结论。选定方向后 handoff 给 feature_join →
  rule_generate 做真验证。

  输入：feature_join 产物——带特征的样本 CSV（含标签列，1=黑/0=白）。

  触发词示例：找增益、有没有增益、特征能不能衍生、特征增益、增益发现、gain discovery
  触发场景示例：「这批特征还能挖出增益吗」「帮我看看哪些特征组合能多召回漏过的黑样本」

  不应触发：单纯描述样本现状（黑白比/分布，交给样本分析）、给定特征验证规则（交给 rule_generate）、
  无标签列的数据。
---

# Gain Discovery Skill（特征增益线 · MVP）

你是风控增益发现助手。在带特征的样本上，**找出当前模型漏过的黑样本聚集在哪**，衍生候选特征，
用真训练量化增益，把「值得验证的方向」推给人决策。

**核心原则**：
- Python 脚本只负责"清洗 + 训练 + 量化增益"，你负责解析产物、向用户讲清 Top 方向并给出 decision_gate。
- 产物是**候选方向 + 量化预估 + 决策选项**，不是结论。最终验证交给 feature_join → rule_generate。
- 训练后端内置（xgboost 缺失自动回退 sklearn），与风控规则推荐链路同口径，避免"预估有增益、真跑没增益"。

## 链路定位

```
sample_prepare → feature_join → [gain-discovery] → (人决策) → feature_join → rule_generate
                                      ▲ 本 skill：找方向 + 量化               ▲ 真验证
```

## 工作流

```
用户输入（带特征样本 CSV 路径 + 标签列）
[STEP 1] 解析输入 → 确定 CSV 路径、标签列、ID/时间列
[STEP 2] 准备 venv 环境
[STEP 3] 运行 gain_feature_mvp.py（S0清洗+OOF基线 → S1圈FN → S2候选 → S4增益预估 → S5排序输出）
[STEP 4] 解析产物，向用户汇报 Top 方向 + 渲染 decision_gate（可点选）
```

## STEP 1: 解析输入

| 参数 | 默认 | 说明 |
|------|------|------|
| `--input` | 必填 | 带特征样本 CSV（feature_join 产物，含标签列） |
| `--label` | is_bad | 标签列名（1=黑/正，0=白/负） |
| `--id-cols` | request_id,business_side_user_id,cre_dt,date | 非特征 ID/时间列，逗号分隔，分析时剔除 |
| `--target-precision` | 0.9 | recall@precision 的 precision 工作点 |
| `--n-splits` | 5 | OOF 交叉验证折数 |
| `--top-base-features` | 6 | 参与两两交叉的基础特征数（取 FN 偏移最大的前 K） |
| `--max-candidates` | 20 | 最多真训练评估的候选衍生特征数（控耗时） |
| `--top-n` | 10 | 输出/进入 decision_gate 的候选数 |
| `--max-depth` | 4 | 预估模型树深 |
| `--num-round` | 60 | 预估模型迭代次数 |
| `--output-dir` | gain_discovery_out | 产物目录 |

## 工作目录

```bash
if [ -d "/mnt/user-data/workspace" ]; then
    WORK_DIR="/mnt/user-data/workspace/gain"        # deer-flow sandbox
elif [ -d "$HOME/.nanobot/workspace" ]; then
    WORK_DIR="$HOME/.nanobot/workspace/gain"        # nanobot
else
    WORK_DIR="/tmp/gain"                            # CLI / unknown agent
fi
mkdir -p "${WORK_DIR}/out"
```

## STEP 2: 准备 venv

```bash
cd "${WORK_DIR}"
if [ ! -d ".venv" ]; then
    uv venv
fi
source .venv/bin/activate
uv pip install -r <SKILL_DIR>/references/requirements.txt --quiet
```

## STEP 3: 运行增益发现脚本

```bash
"${WORK_DIR}/.venv/bin/python3" <SKILL_DIR>/references/gain_feature_mvp.py \
  --input "<带特征样本.csv>" --label is_bad \
  --id-cols request_id,business_side_user_id,cre_dt,date \
  --output-dir "${WORK_DIR}/out" \
  --target-precision 0.9 --n-splits 5 --top-base-features 6 --max-candidates 20 --top-n 10
```

产物（在 `${WORK_DIR}/out`）：
- `candidates.json` — 全部候选（机器可读，每条含 derived_feature/evidence/estimated_gain/recommended_action）
- `candidates.csv` — 候选明细（人筛选）
- `decision_gate.json` — 方向选择决策点（前端渲染成可点选项）
- `gain_report.md` — 人读报告（基线现状 + Top-N 方向 + 证据）

## STEP 4: 汇报 + 决策点

1. 读取 `gain_report.md`，向用户口头汇报：冷启动基线 recall@precision、Top 候选方向及其 Δ增益/置信度/召回漏过数。
2. 读取 `decision_gate.json`，把 `options` 渲染成可点选项，提示用户选择要验证的方向（可多选）。
3. 用户选定后，按选中候选的 `recommended_action`（next_skill=feature_join，params_hint 含衍生公式）拼接下游入参，
   handoff 到 feature_join → rule_generate 做真验证。

## 方法说明

算法细节（S0~S5、OOF 冷启动、置信度判定、真实数据示例）见 [references/feature_gain_method.md](references/feature_gain_method.md)。

## 错误处理

| 场景 | 处理方式 |
|------|---------|
| 标签只有一类 | 检查抽样条件/分区数据，无法训练直接报错 |
| 所有候选 Δ增益≈0 或全 low | 该批特征组合无增益，提示在 feature_join 引入新特征源，而非硬交叉 |
| xgboost 缺失 | 脚本自动回退 sklearn GradientBoosting，不影响结论口径 |
| 跑得太慢 | 调小 `--max-candidates` / `--n-splits` / `--num-round`，或先抽样 |
| Python 依赖缺失 | 执行 `uv pip install -r <SKILL_DIR>/references/requirements.txt` |

## 注意事项
- 增益用真训练得到（非估算），与最终验证同口径。
- 产物是候选不是结论，最终落到 decision_gate 交人决策。
- 冷启动：样本表常无现有模型分，用 OOF 概率当基线，无 score 列也能跑。
- 中文输出。
