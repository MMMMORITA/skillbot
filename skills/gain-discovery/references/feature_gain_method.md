# 特征增益线：方法说明

> 本文解释 `gain-discovery` MVP 里「特征增益」这条线的算法，配合 [gain_feature_mvp.py](gain_feature_mvp.py) 阅读。

## 1. 它回答什么问题

风控策略最常问的一句：**「这个特征能不能衍生 / 有没有增益」**。本线给出**量化答案**：

> 在当前特征基础上，衍生特征 X 能把 `recall@precision=0.9` 从 0.267 提升到 0.289（+0.022，high 置信），多召回 23 个原本漏过的黑样本。

## 2. 五个步骤

### S0 清洗 + 冷启动基线
- 清洗约定：剔除 ID/时间列、删高缺失(>50%)/零方差列、中位数填充。
- **基线**：现实样本表通常没有"现有模型分"列。无 score 时走**冷启动**——对基础特征做 K 折 **OOF（out-of-fold）** 训练，用每条样本在它不参与训练的那一折上的预测概率作为基线分。这样基线无信息泄漏，且无需外部 score 列。

### S1 圈漏过 badcase（FN）
在使 `precision >= target` 的最严阈值下定工作点，黑样本中基线分低于该阈值的即为**漏过 FN**——这就是增益机会所在。

### S2 候选衍生特征

S2 分两步：先选**锚点**，再生成**候选**。

**第一步 选锚点**：在 FN 群体上，对每个基础特征算"相对全体的标准化均值偏移"，挑偏移最大的 Top-K（`--top-base-features`，默认 6）作为可疑锚点特征。

**第二步 生成候选**：支持两种策略，由 `--s2-mode` 切换。

#### `interaction`（默认，推荐）
- **锚点 × 全部基础特征** 两两组合（不再局限于"锚点之间"），生成 `cross = a*b` 与 `ratio = a/(|b|+eps)`，乘积对称去重。
- 对每个合成特征算它**自身对标签的绝对相关 `|corr(合成, y)|`**，按此排序保留 Top-`max_candidates` 进入 S4 真训练。
- 额外记录 `interaction_lift = |corr(合成)| − max(|corr(父a)|, |corr(父b)|)`，即"组合相对最强单父特征的相关性增量"，>0 才是真正的交互溢价（写进 `candidates.json` 的 evidence，仅作证据不参与排序）。

> **为什么这样改**：旧策略只在"锚点之间"两两交叉，单边际弱的特征进不了锚点，**与之相关的交互候选根本不会被生成**，纯交互信号被漏掉。新策略让"锚点 × 任一特征"都有机会成对，再用合成特征自身的 `|corr|` 做预筛——它直接衡量"这个组合到底有没有信息量"，对交互友好，从源头堵住漏洞。

#### `legacy`（旧策略，保留供对比）
- 仅在 Top-K 锚点**之间**两两组合，按生成顺序截断到 `max_candidates`。
- 已知局限见下方对比小节。

> 两类 `cross/ratio` 最能补"单特征 isolate 不出来、需要组合才显现"的信号。


### S4 增益预估（真训练，非估算）
对每个候选：把衍生特征**就地合成**加入特征矩阵 → 用内置 `train_gbm` 做 K 折 OOF 真训练 → 对比加特征前后的 `recall@precision`。
- **Δrecall** = 量化增益。
- **置信度**：看 K 折里增益方向是否一致。≥0.8 折同向且为正 → high；≥0.6 → medium；否则 low。这能把"碰巧某折有效"的噪声打成 low。

> 🔑 训练用的是和风控规则推荐链路一致的 GBM 口径，所以"预估增益"和"最终验证增益"同口径——这是把本 skill 挂在 rule_generate 之上的最大价值。

### S5 排序 + 输出
排序分 = `Δ增益 × 置信度权重(high1.0/medium0.6/low0.3)`。产物：
- `candidates.json` —— 机器可读，含每个候选的 derived_feature / evidence / estimated_gain / recommended_action。
- `candidates.csv` —— 人筛选。
- `decision_gate.json` —— 方向选择决策点，前端渲染成可点选项；选定后用 `recommended_action` 拼 feature_join 入参。
- `gain_report.md` —— 人读报告。

## 3. 真实数据跑通示例

输入：带特征样本表（3002 行 × 17 特征，坏率 0.333，无 score 列 → 冷启动）。

```bash
python3 gain_feature_mvp.py \
  --input stage2_with_features.csv --label is_bad \
  --output-dir out/ --n-splits 5 --top-base-features 5 --max-candidates 12 --top-n 8
```

结果：12 个候选里只有 **1 个 high 置信增益**——

| 候选 | 衍生公式 | Δrecall@p=0.9 | 置信 | 召回漏过 |
|---|---|---|---|---|
| GD-001 | `user_3ds_verification_success_rate_30d * totalttlivewatchtime` | **+0.022** | high | 23 |
| 其余 11 个 | — | ≈0 或负 | low/medium | 0~4 |

> 这个"1 个真信号 + 噪声被正确打低"的结果，正是本 skill 的价值：**把人从盲目试特征里解放出来，只把值得验证的方向推给人决策**。

## 4. 参数调优建议
- 增益普遍偏小 → 基础特征里可能缺关键信号源，应在 feature_join 阶段引入新特征表，而非在现有特征里硬交叉。
- 跑得慢 → 调小 `max_candidates` / `n_splits` / `num_round`，或先抽样。
- 业务用 KS / lift@topK 而非 recall@precision → 改 `recall_at_precision` 度量函数即可（已隔离成单函数）。
- 想复现旧版行为或做策略对比 → 加 `--s2-mode legacy`。

> S2 从 `legacy`（仅锚点间两两交叉）演进到 `interaction`（锚点×全部特征 + |corr| 预筛）的**完整动机、踩坑与 mock 实证对比**见设计文档
> [增益发现Skill设计.md](../../../../增益发现Skill设计.md) 的「S2 候选挑选策略演进」一节，此处不再展开。

## 5. MVP 边界（已知未做）
- 只做**特征增益**，未做样本增益 / 联合建模增益。
- 只圈**漏过 FN**，未处理误伤 FP。
- S2 候选打分用 `|corr|`（线性相关）做预筛，可能漏掉"连合成特征都仍非线性"的极端交互；S4 的 GBM 真训练能部分兜底，但预筛阶段仍是线性近似。
