#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ============================================================
# gain-discovery · 特征增益发现 MVP（skillbot 自洽版）
# ------------------------------------------------------------
# 回答风控策略最看重的问题：「这个特征能不能衍生 / 有没有增益」，
# 并给出量化答案（Δrecall@precision），产物落到 decision_gate。
#
# 流程：
#   S0 清洗 + OOF 基线（冷启动，无现有模型分时用 K 折 out-of-fold 概率当基线）
#   S1 圈漏过 badcase（FN：黑样本但基线分低）
#   S2 在 FN 上找偏移最大的基础特征，两两生成 cross/ratio 候选衍生特征
#   S4 对每个候选：把衍生特征加入特征矩阵，真训练 OOF 对比 Δrecall@precision
#   S5 排序，输出 candidates.json / candidates.csv / gain_report.md / decision_gate.json
#
# 训练后端 train_gbm 内置于本文件，无外部 skill 依赖；xgboost 缺失自动回退
# sklearn GradientBoosting，结论口径不变。
#
# 日志：默认 INFO 输出到 stderr，同时全量（含 DEBUG）落盘到
#   <output-dir>/gain_discovery.log，方便事后排查。--log-level 可调。
#
# 用法：
#   python3 gain_feature_mvp.py --input stage2_with_features.csv --label is_bad \
#       --id-cols request_id,business_side_user_id,cre_dt,date --output-dir out/
# ============================================================
import os
import sys
import json
import time
import logging
import argparse
import warnings
import traceback
from datetime import datetime

import numpy as np
import pandas as pd
from sklearn.model_selection import StratifiedKFold
from sklearn.ensemble import GradientBoostingClassifier

warnings.filterwarnings("ignore")

log = logging.getLogger("gain_discovery")


# ------------------------------------------------------------
# 日志配置：stderr(INFO) + 文件(DEBUG，全量)，带时间戳/级别/行号
# ------------------------------------------------------------
def setup_logging(output_dir, level="INFO"):
    """配置 logger：控制台按指定级别，日志文件始终记录 DEBUG 全量。"""
    log.handlers.clear()
    log.setLevel(logging.DEBUG)
    log.propagate = False

    fmt = logging.Formatter(
        "%(asctime)s | %(levelname)-7s | %(funcName)s:%(lineno)d | %(message)s",
        datefmt="%H:%M:%S",
    )

    console = logging.StreamHandler(sys.stderr)
    console.setLevel(getattr(logging, level.upper(), logging.INFO))
    console.setFormatter(fmt)
    log.addHandler(console)

    log_path = os.path.join(output_dir, "gain_discovery.log")
    try:
        fileh = logging.FileHandler(log_path, mode="w", encoding="utf-8")
        fileh.setLevel(logging.DEBUG)
        fileh.setFormatter(fmt)
        log.addHandler(fileh)
        log.info("日志文件: %s", log_path)
    except Exception as e:  # 文件句柄失败不应阻断主流程
        log.warning("无法创建日志文件 %s: %s（仅输出到控制台）", log_path, e)
    return log_path


# ------------------------------------------------------------
# 训练后端（内置，保证 skill 自洽；与风控规则推荐链路同口径）
# ------------------------------------------------------------
def try_import_xgboost():
    try:
        import xgboost as xgb
        return True, xgb
    except Exception as e:
        log.debug("XGBoost 不可用，将使用 scikit-learn 替代: %s", str(e)[:120])
        return False, None


def train_gbm(X_train, y_train, X_val=None, y_val=None, *, algorithm="auto",
              max_depth=6, min_child_weight=20, gamma=0.05, lambda_=80,
              subsample=0.8, colsample_bytree=0.8, eta=0.01, num_round=50,
              verbose=True):
    """训练梯度提升模型，返回 {'model', 'feature_names', 'algorithm'}。"""
    feature_names = list(X_train.columns)
    log.debug("train_gbm: X_train=%s, 正样本=%d/%d, algorithm=%s, max_depth=%d, num_round=%d",
              X_train.shape, int(np.sum(y_train)), len(y_train), algorithm, max_depth, num_round)
    xgb_available, xgb_module = try_import_xgboost()
    if algorithm == "auto":
        algorithm = "xgboost" if xgb_available else "sklearn"

    if algorithm == "xgboost" and xgb_available:
        train_matrix = xgb_module.DMatrix(X_train, label=y_train)
        params = {
            "verbosity": 2 if verbose else 0,
            "nthread": 4,
            "booster": "gbtree",
            "eta": eta,
            "max_depth": max_depth,
            "min_child_weight": min_child_weight,
            "gamma": gamma,
            "alpha": 0,
            "lambda": lambda_,
            "subsample": subsample,
            "colsample_bytree": colsample_bytree,
            "scale_pos_weight": 1,
            "objective": "binary:logistic",
            "eval_metric": ["auc"],
        }
        evallist = [(train_matrix, "train")]
        if X_val is not None and y_val is not None and len(X_val) > 0:
            evallist.append((xgb_module.DMatrix(X_val, label=y_val), "validate"))
        bst = xgb_module.train(params, train_matrix, num_round, evallist,
                               early_stopping_rounds=10 if len(evallist) > 1 else None)
        return {"model": bst, "feature_names": feature_names, "algorithm": "xgboost"}

    clf = GradientBoostingClassifier(
        n_estimators=num_round,
        max_depth=max_depth,
        learning_rate=eta,
        min_samples_split=min_child_weight,
        min_samples_leaf=max(min_child_weight // 2, 1),
        subsample=subsample,
        random_state=42,
    )
    clf.fit(X_train, y_train)
    return {"model": clf, "feature_names": feature_names, "algorithm": "sklearn"}


def predict_proba(model_data, X):
    """对任意后端返回正类概率（一维 ndarray），屏蔽 xgboost/sklearn 差异。"""
    model = model_data["model"]
    feature_names = model_data["feature_names"]
    missing = [c for c in feature_names if c not in X.columns]
    if missing:
        raise KeyError(f"predict_proba 缺少特征列: {missing}")
    X = X[feature_names]
    if model_data.get("algorithm") == "xgboost":
        _, xgb_module = try_import_xgboost()
        return np.asarray(model.predict(xgb_module.DMatrix(X)))
    return np.asarray(model.predict_proba(X)[:, 1])


# ------------------------------------------------------------
# S0 数据清洗（沿用风控链路成熟约定）
# ------------------------------------------------------------
def load_and_clean(path, label, id_cols):
    log.info("[S0] 读取输入: %s", path)
    if not os.path.isfile(path):
        raise FileNotFoundError(f"输入文件不存在: {path}")
    df = pd.read_csv(path)
    log.info("[S0] 原始形状: %s, 列数=%d", df.shape, df.shape[1])
    log.debug("[S0] 列名: %s", list(df.columns))

    if label not in df.columns:
        raise KeyError(f"标签列 '{label}' 不在数据中。现有列: {list(df.columns)}")

    n0 = len(df)
    df = df[df[label].notna()].copy()
    df[label] = pd.to_numeric(df[label], errors="coerce")
    df = df[df[label].isin([0, 1])].reset_index(drop=True)
    log.info("[S0] 标签清洗: %d -> %d 行（剔除 NaN/非 0-1 标签 %d 行）", n0, len(df), n0 - len(df))
    if len(df) == 0:
        raise ValueError("标签清洗后无有效样本，请检查标签列取值（应为 0/1）。")

    non_feature = set(id_cols) | {label}
    present_id = [c for c in id_cols if c in df.columns]
    log.debug("[S0] 剔除的 ID/时间列(命中): %s；未命中: %s",
              present_id, [c for c in id_cols if c not in df.columns])
    feat_cols = [c for c in df.columns if c not in non_feature]
    log.info("[S0] 候选特征列数（剔除 ID/标签后）: %d", len(feat_cols))

    feat = df[feat_cols].apply(pd.to_numeric, errors="coerce")
    feat = feat.replace([np.inf, -np.inf], np.nan)

    high_nan = feat.columns[feat.isna().mean() > 0.5].tolist()
    if high_nan:
        log.info("[S0] 删除高缺失列(>50%%) %d 个: %s", len(high_nan), high_nan)
        feat = feat.drop(columns=high_nan)

    feat = feat.fillna(feat.median()).fillna(0)

    zero_std = feat.columns[feat.std() == 0].tolist()
    if zero_std:
        log.info("[S0] 删除零方差列 %d 个: %s", len(zero_std), zero_std)
        feat = feat.drop(columns=zero_std)

    feat_cols = list(feat.columns)
    if not feat_cols:
        raise ValueError("清洗后无可用特征列（全部高缺失/零方差？）。")
    y = df[label].astype(int).reset_index(drop=True)
    feat = feat.reset_index(drop=True)
    n_pos, n_neg = int(y.sum()), int((y == 0).sum())
    log.info("[S0] 清洗完成: 特征矩阵=%s, 正样本=%d, 负样本=%d, 坏率=%.4f",
             feat.shape, n_pos, n_neg, n_pos / len(y))
    log.debug("[S0] 最终特征列: %s", feat_cols)
    return feat, y, feat_cols


# ------------------------------------------------------------
# 通用：OOF 概率（冷启动基线 + 候选评估都用它，保证同口径）
# ------------------------------------------------------------
def oof_proba(X, y, cols, n_splits, train_kwargs):
    """返回 out-of-fold 正类概率。"""
    oof = np.zeros(len(y))
    skf = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=42)
    for fold, (tr_idx, va_idx) in enumerate(skf.split(X[cols], y), 1):
        t0 = time.time()
        md = train_gbm(X.iloc[tr_idx][cols], y.iloc[tr_idx], verbose=False, **train_kwargs)
        oof[va_idx] = predict_proba(md, X.iloc[va_idx])
        log.debug("[OOF] fold %d/%d: 训练=%d 验证=%d 耗时=%.2fs",
                  fold, n_splits, len(tr_idx), len(va_idx), time.time() - t0)
    return oof


def recall_at_precision(y, score, target_precision):
    """在使 precision>=target 的最严阈值下取 recall；达不到则返回最高 precision 点的 recall。"""
    order = np.argsort(-score)
    y_sorted = np.asarray(y)[order]
    tp = np.cumsum(y_sorted)
    fp = np.cumsum(1 - y_sorted)
    precision = tp / np.maximum(tp + fp, 1)
    recall = tp / max(int(np.sum(y)), 1)
    ok = precision >= target_precision
    if ok.any():
        return float(recall[ok].max())
    log.debug("recall_at_precision: 达不到目标 precision=%.3f（最高 precision=%.4f），"
              "返回最高 precision 点的 recall", target_precision, float(precision.max()))
    return float(recall[np.argmax(precision)])


def threshold_at_precision(y, score, target_precision):
    order = np.argsort(-score)
    y_sorted = np.asarray(y)[order]
    s_sorted = np.asarray(score)[order]
    tp = np.cumsum(y_sorted)
    fp = np.cumsum(1 - y_sorted)
    precision = tp / np.maximum(tp + fp, 1)
    ok = precision >= target_precision
    if ok.any():
        idx = np.where(ok)[0].max()
        return float(s_sorted[idx])
    return float(s_sorted[np.argmax(precision)])


# ------------------------------------------------------------
# S1 圈漏过 badcase（FN）
# ------------------------------------------------------------
def pick_fn(y, base_oof, target_precision):
    thr = threshold_at_precision(y, base_oof, target_precision)
    is_fn = (y.values == 1) & (base_oof < thr)
    log.info("[S1] 工作阈值=%.4f，漏过黑样本 FN=%d / 黑样本总数=%d",
             thr, int(is_fn.sum()), int(y.sum()))
    if int(is_fn.sum()) == 0:
        log.warning("[S1] FN 为 0：当前基线已能在该 precision 下召回全部黑样本，"
                    "增益空间有限（候选大概率为 low）。")
    return is_fn, thr


# ------------------------------------------------------------
# S2 候选衍生特征：FN 偏移挑特征 + 两两交叉/比值
# ------------------------------------------------------------
def marginal_fn_shift(X, cols, is_fn):
    """每个基础特征在 FN 群体相对全体的标准化均值偏移绝对值（边际可疑度）。"""
    glob_mean = X[cols].mean()
    glob_std = X[cols].std().replace(0, np.nan)
    fn_mean = X.loc[is_fn, cols].mean()
    shift = ((fn_mean - glob_mean) / glob_std).abs()
    return {c: float(shift.get(c, 0) or 0) for c in cols}


def top_fn_features(X, cols, is_fn, k):
    """按 FN 群体相对全体的标准化均值偏移挑出最可疑的 k 个基础特征（锚点）。

    返回 (anchors, marginal_scores)；marginal_scores 含全部特征的边际偏移，
    供交互策略计算「交互增量分」用。
    """
    if int(is_fn.sum()) == 0:
        log.warning("[S2] FN 群体为空，退化为按方差挑锚点特征。")
        picked = list(X[cols].std().sort_values(ascending=False).head(k).index)
        log.info("[S2] 退化挑选锚点特征 Top%d: %s", k, picked)
        return picked, {c: 0.0 for c in cols}
    scores = marginal_fn_shift(X, cols, is_fn)
    ranked = sorted(scores.items(), key=lambda t: t[1], reverse=True)
    picked = [c for c, _ in ranked[:k]]
    log.info("[S2] FN 边际偏移最大的锚点特征 Top%d: %s", k, picked)
    log.debug("[S2] 边际偏移得分明细(全部): %s", [(c, round(s, 4)) for c, s in ranked])
    return picked, scores


def _abs_corr(col_values, y):
    """合成特征与标签的绝对相关系数；零方差/无法计算返回 0。"""
    s = float(np.nanstd(col_values))
    if s == 0 or np.isnan(s):
        return 0.0
    col = np.nan_to_num(col_values, nan=float(np.nanmean(col_values)))
    c = np.corrcoef(col, np.asarray(y, dtype=float))[0, 1]
    return 0.0 if np.isnan(c) else abs(float(c))


def make_candidates_interaction(X, y, cols, anchors, max_candidates):
    """新策略：锚点 × 全部特征 生成 cross/ratio，按合成特征「对标签的绝对相关」预筛 Top-N。

    为什么不再用「FN 边际偏移」给候选打分：边际偏移是线性/单变量度量，会把「单父特征
    已经较相关、组合后才真正显现」的纯交互信号排到后面（父特征边际越强，按差值打分越吃亏）。
    改用合成特征自身对标签的 |corr| 直接衡量「这个组合到底有没有信息量」——它对交互友好：
    只要锚点 × 任一特征的组合携带信号，就能被排到前面、进入 S4 真训练，
    从而堵住旧策略「单边际弱的特征进不了锚点、相关候选根本不生成」的漏洞。

    每个候选额外记录 interaction_lift = |corr(合成)| − max(|corr(父a)|, |corr(父b)|)，
    即「组合相对最强单父特征的相关性增量」，>0 才是真正的交互溢价（仅作证据，不参与排序）。
    """
    parent_corr = {c: _abs_corr(X[c].values, y) for c in cols}
    seen = set()
    scored = []  # (abs_corr, cand)
    for a in anchors:
        for b in cols:
            if a == b:
                continue
            for kind in ("cross", "ratio"):
                if kind == "cross":
                    key = ("cross", frozenset((a, b)))  # 乘积对称，去重
                    name = f"cross__{a}__x__{b}"
                else:
                    key = ("ratio", a, b)               # 比值不对称
                    name = f"ratio__{a}__div__{b}"
                if key in seen:
                    continue
                seen.add(key)
                cand = {"name": name, "kind": kind, "a": a, "b": b}
                col = synth_feature(X, cand).values
                score = _abs_corr(col, y)
                cand["interaction_score"] = round(score, 4)
                cand["interaction_lift"] = round(
                    score - max(parent_corr.get(a, 0.0), parent_corr.get(b, 0.0)), 4)
                scored.append((score, cand))
    scored.sort(key=lambda t: t[0], reverse=True)
    picked = [c for _, c in scored[:max_candidates]]
    log.info("[S2] 交互策略：锚点 %d × 全部 %d 特征 → 去重生成 %d 个候选，按 |corr(合成,标签)| 保留 Top%d",
             len(anchors), len(cols), len(scored), len(picked))
    log.debug("[S2] |corr| 排序(保留): %s",
              [(c["name"], c["interaction_score"]) for c in picked])
    if picked:
        log.info("[S2] 相关性最高候选: %s (|corr|=%.4f, 交互溢价=%+.4f)",
                 picked[0]["name"], picked[0]["interaction_score"], picked[0]["interaction_lift"])
    return picked


def make_candidates_legacy(base_feats, max_candidates):
    """旧策略：仅在 Top-K 锚点之间两两 乘积(cross)/比值(ratio)，顺序截断。

    局限：单边际弱的特征进不了 Top-K 锚点，与之相关的交互候选根本不会被生成。
    """
    cands = []
    for i in range(len(base_feats)):
        for j in range(i + 1, len(base_feats)):
            a, b = base_feats[i], base_feats[j]
            cands.append({"name": f"cross__{a}__x__{b}", "kind": "cross", "a": a, "b": b})
            cands.append({"name": f"ratio__{a}__div__{b}", "kind": "ratio", "a": a, "b": b})
    log.info("[S2] 旧策略：%d 锚点两两组合生成 %d 个候选，顺序截断到 %d",
             len(base_feats), len(cands), max_candidates)
    return cands[:max_candidates]


def synth_feature(X, cand):
    a, b = X[cand["a"]], X[cand["b"]]
    if cand["kind"] == "cross":
        return (a * b).astype(np.float32)
    return (a / (b.abs() + 1e-6)).astype(np.float32)


# ------------------------------------------------------------
# S4 增益预估：加入候选特征 → 真训练 OOF → Δrecall@precision
# ------------------------------------------------------------
def estimate_gain(X, y, base_cols, base_recall, candidates, is_fn,
                  n_splits, target_precision, train_kwargs):
    results = []
    skf = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=42)
    folds = list(skf.split(X[base_cols], y))
    n_total = len(candidates)
    log.info("[S4] 开始评估 %d 个候选（每个 %d 折 OOF 真训练）", n_total, n_splits)
    for ci, cand in enumerate(candidates, 1):
        t0 = time.time()
        try:
            Xc = X.copy()
            Xc[cand["name"]] = synth_feature(X, cand)
            cols = base_cols + [cand["name"]]
            per_fold = []
            oof = np.zeros(len(y))
            for tr_idx, va_idx in folds:
                md = train_gbm(Xc.iloc[tr_idx][cols], y.iloc[tr_idx], verbose=False, **train_kwargs)
                p = predict_proba(md, Xc.iloc[va_idx])
                oof[va_idx] = p
                per_fold.append(recall_at_precision(y.iloc[va_idx], p, target_precision))
            new_recall = recall_at_precision(y, oof, target_precision)
            delta = new_recall - base_recall
            deltas_per_fold = np.array(per_fold) - base_recall
            consistent = float((np.sign(deltas_per_fold) == np.sign(delta)).mean()) if delta != 0 else 0.0
            conf = "high" if (delta > 0 and consistent >= 0.8) else \
                   ("medium" if (delta > 0 and consistent >= 0.6) else "low")
            thr_new = threshold_at_precision(y, oof, target_precision)
            recovered = int(((y.values == 1) & is_fn & (oof >= thr_new)).sum())
            results.append({
                "candidate": cand,
                "base_recall": round(base_recall, 4),
                "new_recall": round(new_recall, 4),
                "delta_recall": round(delta, 4),
                "fold_consistency": round(consistent, 2),
                "confidence": conf,
                "recovered_fn": recovered,
            })
            log.info("[S4] (%d/%d) %s: Δrecall=%+.4f conf=%s 召回漏过+%d 折一致性=%.2f 耗时=%.2fs",
                     ci, n_total, cand["name"], delta, conf, recovered, consistent, time.time() - t0)
            log.debug("[S4] (%d/%d) %s 各折 recall=%s", ci, n_total, cand["name"],
                      [round(v, 4) for v in per_fold])
        except Exception:
            log.error("[S4] (%d/%d) 候选 %s 评估失败，已跳过：\n%s",
                      ci, n_total, cand.get("name"), traceback.format_exc())
            continue
    log.info("[S4] 评估完成：成功 %d / 候选 %d", len(results), n_total)
    return results


# ------------------------------------------------------------
# S5 排序 + 输出
# ------------------------------------------------------------
CONF_W = {"high": 1.0, "medium": 0.6, "low": 0.3}


def _formula(c):
    return f"{c['a']} * {c['b']}" if c["kind"] == "cross" else f"{c['a']} / (abs({c['b']}) + 1e-6)"


def build_candidates_json(results, meta):
    items = []
    ranked = sorted(results, key=lambda r: r["delta_recall"] * CONF_W[r["confidence"]],
                    reverse=True)
    for i, r in enumerate(ranked, 1):
        c = r["candidate"]
        rank_score = round(max(r["delta_recall"], 0) * CONF_W[r["confidence"]], 5)
        items.append({
            "candidate_id": f"GD-{i:03d}",
            "gain_source": "feature",
            "title": f"{c['kind']} 衍生特征: {c['a']} {'×' if c['kind']=='cross' else '÷'} {c['b']}",
            "derived_feature": {"name": c["name"], "kind": c["kind"], "inputs": [c["a"], c["b"]]},
            "evidence": {
                "discovery_method": "fn_shift + interaction",
                "fold_consistency": r["fold_consistency"],
                "recovered_fn": r["recovered_fn"],
                "interaction_lift": c.get("interaction_lift"),
            },
            "estimated_gain": {
                "metric": meta["metric"],
                "baseline_value": r["base_recall"],
                "projected_value": r["new_recall"],
                "delta": r["delta_recall"],
                "method": f"oof_{meta['algorithm']}_addfeature",
                "confidence": r["confidence"],
            },
            "recommended_action": {
                "next_skill": "feature_join",
                "params_hint": {"new_feature": c["name"],
                                "formula": _formula(c), "then": "rule_generate"},
            },
            "rank_score": rank_score,
        })
    return items


def build_decision_gate(items, top_n):
    opts = []
    for it in items[:top_n]:
        g = it["estimated_gain"]
        opts.append({
            "id": it["candidate_id"],
            "label": f"{it['title']} (预估 {g['metric']} {g['delta']:+.3f}, {g['confidence']}置信)",
            "gain_source": "feature",
            "rank_score": it["rank_score"],
        })
    return {
        "decision_gate": {
            "type": "direction_selection",
            "prompt": f"发现 {len(items)} 个潜在特征增益方向，请选择要验证的方向（可多选）",
            "options": opts,
            "on_select": "对选中候选执行 recommended_action.next_skill（feature_join → rule_generate）",
        }
    }


def write_report(items, meta, out_dir):
    lines = [
        "# 特征增益发现报告（gain-discovery MVP）", "",
        f"- 生成时间: {datetime.now():%Y-%m-%d %H:%M:%S}",
        f"- 样本量: {meta['n_rows']}，坏率: {meta['bad_rate']:.4f}",
        f"- 基础特征数: {meta['n_base_feat']}，训练后端: {meta['algorithm']}",
        f"- 增益度量: {meta['metric']}（冷启动 OOF 基线 = {meta['base_recall']:.4f}）",
        f"- 评估候选数: {meta['n_candidates']}", "",
        "## Top 候选方向", "",
        "| 排名 | 候选 | 衍生公式 | Δ增益 | 置信 | 召回漏过 |",
        "|---|---|---|---|---|---|",
    ]
    for it in items[:meta["top_n"]]:
        g = it["estimated_gain"]
        lines.append(
            f"| {it['candidate_id']} | {it['title']} | `{it['recommended_action']['params_hint']['formula']}` "
            f"| {g['delta']:+.4f} | {g['confidence']} | {it['evidence']['recovered_fn']} |")
    lines += ["", "## 说明",
              "- Δ增益 = 加入该衍生特征后，OOF recall@固定precision 相对冷启动基线的变化。",
              "- 置信度由 K 折方向一致性决定；low 多为噪声或达不到目标 precision，需真验证。",
              "- 选定方向后由 feature_join 落地衍生特征，再交 rule_generate 做最终验证。"]
    path = os.path.join(out_dir, "gain_report.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return path


def run(args):
    """主计算流程；异常向上抛由 main 统一记录。"""
    id_cols = [c.strip() for c in args.id_cols.split(",") if c.strip()]
    train_kwargs = dict(algorithm="auto", max_depth=args.max_depth, num_round=args.num_round)
    log.info("参数: target_precision=%.3f n_splits=%d top_base_features=%d "
             "max_candidates=%d top_n=%d max_depth=%d num_round=%d s2_mode=%s",
             args.target_precision, args.n_splits, args.top_base_features,
             args.max_candidates, args.top_n, args.max_depth, args.num_round, args.s2_mode)

    X, y, base_cols = load_and_clean(args.input, args.label, id_cols)
    if y.nunique() < 2:
        log.error("标签只有一类（nunique=%d），无法训练。请检查抽样条件/分区数据。", y.nunique())
        return None
    if args.n_splits > int(y.sum()):
        log.warning("n_splits=%d 大于正样本数=%d，OOF 可能不稳定，建议调小 --n-splits。",
                    args.n_splits, int(y.sum()))

    log.info("[S0] 计算冷启动 OOF 基线（%d 折）", args.n_splits)
    t0 = time.time()
    base_oof = oof_proba(X, y, base_cols, args.n_splits, train_kwargs)
    base_recall = recall_at_precision(y, base_oof, args.target_precision)
    algorithm = "xgboost" if try_import_xgboost()[0] else "sklearn"
    log.info("[S0] 基线 recall@precision=%.3f: %.4f (后端=%s, 耗时=%.2fs)",
             args.target_precision, base_recall, algorithm, time.time() - t0)

    is_fn, _thr = pick_fn(y, base_oof, args.target_precision)
    anchors, _marginal = top_fn_features(X, base_cols, is_fn, args.top_base_features)
    if args.s2_mode == "legacy":
        candidates = make_candidates_legacy(anchors, args.max_candidates)
    else:
        candidates = make_candidates_interaction(
            X, y, base_cols, anchors, args.max_candidates)
    log.info("[S2] 共生成 %d 个候选衍生特征（策略=%s）", len(candidates), args.s2_mode)

    results = estimate_gain(X, y, base_cols, base_recall, candidates, is_fn,
                            args.n_splits, args.target_precision, train_kwargs)
    if not results:
        log.error("所有候选评估失败或无候选，无法输出。请查看上方错误日志。")
        return None

    meta = {
        "metric": f"recall@precision={args.target_precision}",
        "algorithm": algorithm, "n_rows": len(y),
        "bad_rate": float(y.mean()), "n_base_feat": len(base_cols),
        "n_candidates": len(candidates), "base_recall": base_recall, "top_n": args.top_n,
    }
    items = build_candidates_json(results, meta)

    cand_json = os.path.join(args.output_dir, "candidates.json")
    cand_csv = os.path.join(args.output_dir, "candidates.csv")
    gate_json = os.path.join(args.output_dir, "decision_gate.json")
    with open(cand_json, "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "candidates": items}, f, ensure_ascii=False, indent=2)
    pd.json_normalize(items).to_csv(cand_csv, index=False, encoding="utf-8")
    with open(gate_json, "w", encoding="utf-8") as f:
        json.dump(build_decision_gate(items, args.top_n), f, ensure_ascii=False, indent=2)
    report = write_report(items, meta, args.output_dir)
    log.info("产物已写出: %s | %s | %s | %s",
             os.path.basename(cand_json), os.path.basename(cand_csv),
             os.path.basename(gate_json), os.path.basename(report))

    n_high = sum(1 for it in items if it["estimated_gain"]["confidence"] == "high")
    log.info("汇总: 共 %d 候选，其中 high 置信 %d 个", len(items), n_high)
    if items:
        log.info("Top 候选:")
        for it in items[: min(5, len(items))]:
            g = it["estimated_gain"]
            log.info("  %s %s  Δ=%+.4f (%s)", it["candidate_id"], it["title"],
                     g["delta"], g["confidence"])
    return args.output_dir


def main():
    ap = argparse.ArgumentParser(description="特征增益发现 MVP（skillbot 自洽版）")
    ap.add_argument("--input", required=True, help="带特征样本 CSV（feature_join 产物）")
    ap.add_argument("--label", default="is_bad", help="标签列")
    ap.add_argument("--id-cols", default="request_id,business_side_user_id,cre_dt,date",
                    help="非特征 ID/时间列，逗号分隔")
    ap.add_argument("--output-dir", default="gain_discovery_out", help="产物目录")
    ap.add_argument("--target-precision", type=float, default=0.9, help="recall@precision 的 precision 目标")
    ap.add_argument("--n-splits", type=int, default=5, help="OOF 折数")
    ap.add_argument("--top-base-features", type=int, default=6,
                    help="作为交互锚点的基础特征数（取 FN 边际偏移最大的前 K）")
    ap.add_argument("--max-candidates", type=int, default=20, help="最多评估的候选衍生特征数")
    ap.add_argument("--s2-mode", default="interaction", choices=["interaction", "legacy"],
                    help="S2 候选挑选策略：interaction=锚点×全部特征+交互增量分预筛(默认，能挖单边际弱/交互强信号)；"
                         "legacy=仅锚点间两两交叉(旧策略)")
    ap.add_argument("--top-n", type=int, default=10, help="输出候选数")
    ap.add_argument("--max-depth", type=int, default=4)
    ap.add_argument("--num-round", type=int, default=60)
    ap.add_argument("--log-level", default="INFO",
                    choices=["DEBUG", "INFO", "WARNING", "ERROR"], help="控制台日志级别")
    args = ap.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)
    setup_logging(args.output_dir, args.log_level)
    log.info("==== gain-discovery 特征增益发现 开始 ====")
    t0 = time.time()
    try:
        out = run(args)
    except Exception:
        log.critical("运行失败，未捕获异常：\n%s", traceback.format_exc())
        sys.exit(1)
    log.info("==== 结束，总耗时=%.2fs ====", time.time() - t0)
    if out is None:
        sys.exit(2)


if __name__ == "__main__":
    main()
