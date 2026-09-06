# BNPL Rule Set Generator — Skill Package

一个可移植的 Agent Skill 包：从样本表 `df` 和验证表 `check` 出发，用定制版 XGBoost 挖掘树路径候选规则，经 train/OOT lift 过滤后，在 check 拦截率上限约束下贪心筛选出最终规则集。除生成模式外，还支持参数扫描模式（对比多个 `max_depth` × 一段 `max_intercept`，产出对比曲线与推荐参数）。

## 目录结构

```
bnpl-rule-set-generator/
├── SKILL.md                     # Skill 定义（YAML frontmatter + 完整说明）
├── evals/
│   └── evals.json               # 评测用例
└── scripts/
    ├── bnbl.py                  # 生成模式后端（CLI 入口）
    ├── sweep_and_plot.py        # 扫描模式后端（import bnbl，复用 run_once）
    └── xgboost_runtime/         # 随包分发的定制版 XGBoost（Python 源码）
        └── xgboost/
            └── lib/
                └── libxgboost.so   # 预编译动态库（已随包内置，见下）
```

## 如何接入其它 Agent 平台

1. 把整个 `bnpl-rule-set-generator/` 目录放到目标平台的 skills 目录下。
2. 平台读取 `SKILL.md` 的 frontmatter（`name` / `description`）完成注册。
3. Agent 按 `SKILL.md` 的交互流程收集参数 → 确认 → 调用 `scripts/bnbl.py`（生成模式）或 `scripts/sweep_and_plot.py`（扫描模式）。

## 运行环境要求

- **平台**：Linux **x86_64**（`libxgboost.so` 为该架构预编译，arm64/其它架构无法加载）。
- **Python**：≥ 3.8（定制版 XGBoost 为 2.0.3，推荐 3.13）。
- **Python 依赖**：`numpy`、`pandas`；扫描模式额外需 `matplotlib`，导出 xlsx 需 `openpyxl`（缺失时自动降级为多个 CSV）。
- **XGBoost 动态库**：本包已**内置** `scripts/xgboost_runtime/xgboost/lib/libxgboost.so`，**无需联网下载**，开箱即用。
  - `bnbl.py` 启动时会校验该文件 md5，命中即直接使用。
  - 若在无法访问字节内网的环境中丢失该文件，脚本会尝试从内网地址下载并**失败**；请确保随包分发的 `libxgboost.so` 完整保留。

## 快速自检

```bash
cd bnpl-rule-set-generator/scripts
python3 bnbl.py --help          # 应打印全部 CLI 参数
python3 sweep_and_plot.py --help
```

## 生成模式示例

```bash
cd bnpl-rule-set-generator/scripts
python3 bnbl.py \
  --df-path /path/df.csv \
  --check-path /path/check.csv \
  --date-col loan_date \
  --label-col fpd7_flag \
  --amount-col fpd7_ovd_num \
  --principal-col fpd7_principal_den \
  --oot-start-date 2026-05-20 \
  --lift-threshold-train 1.5 \
  --lift-threshold-oot 1.25 \
  --max-intercept 0.1 \
  --max-depth 5 \
  --fixed-feature-list "" \
  --rule-pool-path /path/rule_pool.csv \
  --rule-set-path /path/rule_set.csv
```

## 扫描模式示例

```bash
cd bnpl-rule-set-generator/scripts
python3 sweep_and_plot.py \
  --df-path /path/df.csv \
  --check-path /path/check.csv \
  --date-col loan_date \
  --label-col fpd7_flag \
  --amount-col fpd7_ovd_num \
  --principal-col fpd7_principal_den \
  --oot-start-date 2026-05-20 \
  --lift-threshold-train 1.5 \
  --lift-threshold-oot 1.25 \
  --fixed-feature-list "" \
  --depth-list 3,4,5 \
  --intercept-range 0.10,0.20,0.02 \
  --out-dir /path/sweep_out
```

必填参数、列要求、控制组切分、提前停止（ROI=0）等完整说明详见 `SKILL.md`。
