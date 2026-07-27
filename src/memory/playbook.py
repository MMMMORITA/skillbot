"""Experience-loop persistence: playbook store + keyword recall.

A playbook entry records a human-adopted decision (a decision-gate choice the
user made). Entries persist across agent sessions — they live in an
append-only JSONL file outside the session lifecycle, so ``session.cleanup()``
never drops them. Recall reuses bottleneck-1's dependency-free tokenizer +
TF-IDF so a similar request later surfaces the past decision as a few-shot.
"""

from __future__ import annotations

import json
import logging
import math
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

from chat.skill import _tokenize

_log = logging.getLogger(__name__)


def _jaccard(a: set[str], b: set[str]) -> float:
    """Token-set Jaccard similarity, normalized to [0, 1]. Empty set → 0.0."""
    if not a or not b:
        return 0.0
    union = len(a | b)
    return len(a & b) / union if union else 0.0


@dataclass
class PlaybookEntry:
    """One human-adopted decision, keyed by the request that triggered it."""

    request: str
    gate_type: str = ""
    question: str = ""
    chosen: str = ""
    evidence: str = ""
    mode: str = ""
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())

    def searchable(self) -> str:
        """Text used for keyword recall — the request plus the decision context."""
        return " ".join([self.request, self.question, self.chosen])


class PlaybookStore:
    """Append-only JSONL store of adopted decisions with keyword recall.

    Keyword-only on purpose — matches the retrieval approach used for skills
    (no embedding model in this env).
    """

    def __init__(self, path: str) -> None:
        self._path = Path(path)

    # ---- persistence ----

    def add(self, entry: PlaybookEntry) -> None:
        """Append one entry to the JSONL file (creates parent dirs)."""
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with open(self._path, "a", encoding="utf-8") as f:
                f.write(json.dumps(asdict(entry), ensure_ascii=False, default=str) + "\n")
        except OSError as exc:
            _log.warning("playbook add failed: %s", exc)

    def _rewrite(self, entries: list[PlaybookEntry]) -> None:
        """Atomically rewrite the whole file (temp file + os.replace).

        Needed for UPDATE/DELETE — a JSONL append log can't edit in place, so a
        correcting write replaces the file wholesale without a torn read.
        """
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(self._path.suffix + ".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                for e in entries:
                    f.write(json.dumps(asdict(e), ensure_ascii=False, default=str) + "\n")
            os.replace(tmp, self._path)
        except OSError as exc:
            _log.warning("playbook rewrite failed: %s", exc)

    def upsert(self, entry: PlaybookEntry, sim_threshold: float = 0.5) -> str:
        """Rule-based Memory-Manager write: decide ADD / UPDATE / NOOP.

        Inspired by Memory-R1's editable memory (ADD/UPDATE/DELETE/NOOP), but
        rule-based (no RL) since this env has no training loop. Before writing,
        find the most similar prior entry *of the same gate_type* by request
        token overlap (Jaccard):

        - similar enough (>= threshold) and same choice  -> NOOP (skip, no dup)
        - similar enough but a different choice           -> UPDATE (correct it)
        - otherwise                                       -> ADD (new precedent)

        Returns the action taken: ``"add"`` | ``"update"`` | ``"noop"``.
        """
        entries = self.all()
        q_tokens = set(_tokenize(entry.request))

        best_idx, best_sim = -1, 0.0
        for i, e in enumerate(entries):
            if e.gate_type != entry.gate_type:
                continue
            sim = _jaccard(q_tokens, set(_tokenize(e.request)))
            if sim > best_sim:
                best_idx, best_sim = i, sim

        if best_idx < 0 or best_sim < sim_threshold:
            self.add(entry)
            return "add"

        if entries[best_idx].chosen == entry.chosen:
            return "noop"

        entries[best_idx] = entry
        self._rewrite(entries)
        return "update"

    def all(self) -> list[PlaybookEntry]:
        """Read every entry back. Bad lines are skipped."""
        if not self._path.is_file():
            return []
        out: list[PlaybookEntry] = []
        try:
            for line in self._path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(PlaybookEntry(**json.loads(line)))
                except (TypeError, ValueError):
                    continue
        except OSError as exc:
            _log.warning("playbook read failed: %s", exc)
        return out

    # ---- recall (keyword TF-IDF, reuses skill tokenizer) ----

    def recall(self, query: str, top_k: int = 3) -> list[tuple[PlaybookEntry, float]]:
        """Rank stored entries by keyword relevance to *query*.

        Returns ``[(entry, score), ...]`` sorted by score desc, only positive
        scores, limited to *top_k*. Empty store or no overlap yields ``[]``.
        """
        entries = self.all()
        if not entries:
            return []

        docs = [_tokenize(e.searchable()) for e in entries]
        n_docs = len(docs)
        df: dict[str, int] = {}
        for toks in docs:
            for t in set(toks):
                df[t] = df.get(t, 0) + 1
        idf = {t: math.log(1 + n_docs / (1 + c)) for t, c in df.items()}

        q_tokens = set(_tokenize(query))
        scored: list[tuple[PlaybookEntry, float]] = []
        for entry, toks in zip(entries, docs):
            tf: dict[str, int] = {}
            for t in toks:
                tf[t] = tf.get(t, 0) + 1
            score = sum(tf[t] * idf.get(t, 0.0) for t in q_tokens if t in tf)
            if score > 0:
                scored.append((entry, score))
        scored.sort(key=lambda x: -x[1])
        return scored[:top_k]

    # ---- self-adaptive gate (KnowSelf-style: recall before asking) ----

    def annotate_gate(self, gate: dict, request: str, sim_threshold: float = 0.5) -> bool:
        """Fold a matching past decision into *gate* in place (conservative).

        KnowSelf-inspired: before re-asking the human the same question, check
        the playbook. If a prior decision for a similar request (same gate_type,
        request Jaccard >= threshold) picked one of the *current* options, mark
        that option ``recommended`` and prefix its evidence with a precedent
        note ("↩ 上次相似诉求你选了这个"). The full gate is still shown — we only
        pre-select + hint, never auto-skip — so a genuine new divergence is not
        silently answered.

        Returns True if an option was annotated, else False (gate untouched).
        """
        options = gate.get("options")
        if not isinstance(options, list) or not options:
            return False
        gate_type = gate.get("type", "")
        q_tokens = set(_tokenize(request))

        best: PlaybookEntry | None = None
        best_sim = 0.0
        for e in self.all():
            if e.gate_type != gate_type or not e.chosen:
                continue
            sim = _jaccard(q_tokens, set(_tokenize(e.request)))
            if sim >= sim_threshold and sim > best_sim:
                best, best_sim = e, sim
        if best is None:
            return False

        want = best.chosen.strip()
        target = None
        for opt in options:
            if isinstance(opt, dict) and (opt.get("label") or "").strip() == want:
                target = opt
                break
        if target is None:
            return False

        # Single-recommended invariant: the precedent option becomes the only
        # preselected one (the frontend preselects the first `recommended`).
        for opt in options:
            if isinstance(opt, dict) and opt is not target:
                opt.pop("recommended", None)
        target["recommended"] = True
        note = f"↩ 上次相似诉求你选了这个（{best.chosen}）"
        ev = target.get("evidence") or ""
        target["evidence"] = f"{note}\n{ev}" if ev else note
        return True
