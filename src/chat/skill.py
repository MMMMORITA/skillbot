"""Cross-agent skill management — install, list, uninstall, prompt injection."""

from __future__ import annotations

import json
import logging
import math
import os
import re
import shutil
import tempfile
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

import yaml

_log = logging.getLogger(__name__)

_FRONTMATTER_RE = re.compile(r"^---\s*\r?\n(.*?)\r?\n---\s*(?:\r?\n|$)", re.DOTALL)
_STATE_FILE = ".skill_state.json"

_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
_ASCII_TOKEN_RE = re.compile(r"[a-z0-9_]+")

# LLM rerank (DeepSeek chat). No embedding API is reachable in this env, so
# semantic recall is done by re-ranking the keyword top-K with a chat model.
_DEEPSEEK_BASE = os.environ.get("DEEPSEEK_API_BASE", "https://api.deepseek.com").rstrip("/")
_DEEPSEEK_MODEL = os.environ.get("SKILLBOT_RERANK_MODEL", "deepseek-chat")


def _est_tokens(text: str) -> int:
    """Rough token estimate (~3.5 chars/token for mixed CN/EN)."""
    return len(text) * 10 // 35


def _tokenize(text: str) -> list[str]:
    """Dependency-free tokenizer for mixed CN/EN keyword matching.

    No jieba in this env, so CJK is split into char unigrams + adjacent
    bigrams (bigrams give the discriminative power a word segmenter would),
    while ASCII runs (identifiers like ``feature_join``, ``tqs``) are kept
    whole and also split on ``_``.
    """
    text = text.lower()
    tokens: list[str] = []
    for m in _ASCII_TOKEN_RE.finditer(text):
        tok = m.group(0)
        tokens.append(tok)
        if "_" in tok:
            tokens.extend(p for p in tok.split("_") if p)
    cjk = _CJK_RE.findall(text)
    tokens.extend(cjk)
    tokens.extend(cjk[i] + cjk[i + 1] for i in range(len(cjk) - 1))
    return tokens


def _clean_macos_junk(root: Path) -> None:
    """Remove macOS resource forks and __MACOSX dirs from extracted zip."""
    for item in list(root.rglob("*")):
        if item.name == "__MACOSX" or item.name.startswith("._"):
            try:
                if item.is_dir():
                    shutil.rmtree(item)
                else:
                    item.unlink()
            except Exception:
                pass


@dataclass
class SkillInfo:
    name: str
    description: str
    path: str
    enabled: bool = False
    body: str = ""
    category: str = ""   # top-level folder under the skill root (custom/github/…)


def _splice_top_level_block(text: str, key: str, block: str) -> str:
    """Replace (or append) a top-level YAML mapping block by *key*.

    Preserves all other content (comments included). A top-level block is the
    ``key:`` line plus every following line until the next line that starts in
    column 0 with a non-space, non-comment character. *block* is the full
    replacement text (e.g. ``"skills:\\n  disabled:\\n  - foo"``).
    """
    lines = text.splitlines()
    start = None
    for i, ln in enumerate(lines):
        if ln.startswith(f"{key}:"):
            start = i
            break
    block_lines = block.splitlines()
    if start is None:
        # append as a new trailing block
        tail = "" if text.endswith("\n") else "\n"
        return text + tail + "\n" + "\n".join(block_lines) + "\n"
    # find end: next top-level key (column-0, not indented, not a comment/blank)
    end = len(lines)
    for j in range(start + 1, len(lines)):
        ln = lines[j]
        if ln and not ln[0].isspace() and not ln.lstrip().startswith("#"):
            end = j
            break
    new_lines = lines[:start] + block_lines + lines[end:]
    result = "\n".join(new_lines)
    return result + "\n" if text.endswith("\n") else result


class SkillManager:
    """Manage skills in a directory: list, install from .zip, uninstall.

    Enable/disable state is persisted in ``.skill_state.json`` inside the
    skill directory.  All installed skills default to enabled.
    """

    def __init__(self, skill_dir: str) -> None:
        self._dir = Path(skill_dir)
        self._disabled: set[str] = set()
        self._load_state()

    # ------------------------------------------------------------------
    # state persistence
    # ------------------------------------------------------------------

    @property
    def _state_path(self) -> Path:
        return self._dir / _STATE_FILE

    def _load_state(self) -> None:
        try:
            data = json.loads(self._state_path.read_text(encoding="utf-8"))
            self._disabled = set(data.get("disabled", []))
        except Exception:
            self._disabled = set()

    def _save_state(self) -> None:
        if not self._dir.is_dir():
            self._dir.mkdir(parents=True, exist_ok=True)
        self._state_path.write_text(
            json.dumps({"disabled": sorted(self._disabled)}, indent=2),
            encoding="utf-8",
        )

    # ------------------------------------------------------------------
    # discovery
    # ------------------------------------------------------------------

    def _iter_skill_dirs(self, root: Path | None = None,
                         depth: int = 0, max_depth: int = 4):
        """Yield directories that directly contain a SKILL.md.

        Skills may live at the top level (``<dir>/<skill>/SKILL.md``) or nested
        under category folders (``<dir>/<category>/<skill>/SKILL.md``). We
        recurse into folders that lack a SKILL.md and stop descending as soon
        as one is found — so a skill's own subdirs (``references/`` etc.) are
        never mistaken for separate skills.
        """
        base = root if root is not None else self._dir
        if not base.is_dir() or depth > max_depth:
            return
        for entry in sorted(base.iterdir()):
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            if self._find_skill_md(entry):
                yield entry
            else:
                yield from self._iter_skill_dirs(entry, depth + 1, max_depth)

    def _locate_skill_dir(self, name: str) -> Path | None:
        """Find a skill's directory by name, searching nested categories.

        Matches the directory name first (fast path for top-level skills),
        then falls back to the SKILL.md frontmatter ``name``.
        """
        direct = self._dir / name
        if self._find_skill_md(direct):
            return direct
        for skill_dir in self._iter_skill_dirs():
            if skill_dir.name == name:
                return skill_dir
            md = self._find_skill_md(skill_dir)
            if md:
                info = self._parse_skill(md)
                if info and info.name == name:
                    return skill_dir
        return None

    def list_skills(self) -> list[SkillInfo]:
        """List all installed skills with enable status."""
        skills: list[SkillInfo] = []
        for skill_dir in self._iter_skill_dirs():
            md = self._find_skill_md(skill_dir)
            if md:
                info = self._parse_skill(md)
                if info:
                    info.enabled = info.name not in self._disabled
                    info.category = self._category_of(skill_dir)
                    skills.append(info)
        return skills

    def _category_of(self, skill_dir: Path) -> str:
        """The top-level folder a skill lives under, relative to the root.

        ``<root>/custom/foo`` → ``custom``; a skill sitting directly at
        ``<root>/foo`` has no category → ``""`` (rendered as "Uncategorized").
        """
        try:
            rel = skill_dir.relative_to(self._dir)
        except ValueError:
            return ""
        parts = rel.parts
        return parts[0] if len(parts) > 1 else ""


    def _find_skill_md(self, skill_dir: Path) -> Path | None:
        """Find SKILL.md in a directory, case-insensitive."""
        if not skill_dir.is_dir():
            return None
        for f in skill_dir.iterdir():
            if f.is_file() and f.name.lower() == "skill.md":
                return f
        return None

    def get_skill(self, name: str) -> SkillInfo | None:
        """Get a single skill by name."""
        skill_dir = self._locate_skill_dir(name)
        if not skill_dir:
            return None
        md = self._find_skill_md(skill_dir)
        if not md:
            return None
        info = self._parse_skill(md)
        if info:
            info.enabled = info.name not in self._disabled
            info.category = self._category_of(skill_dir)
        return info

    # ------------------------------------------------------------------
    # install / uninstall
    # ------------------------------------------------------------------

    def install(self, zip_path: str) -> SkillInfo:
        """Install a skill from a .zip file.

        The zip must contain a single top-level directory whose name
        becomes the skill name. That directory must contain SKILL.md.
        New skills default to enabled.
        """
        zpath = Path(zip_path)
        if not zpath.is_file():
            raise FileNotFoundError(f"zip not found: {zip_path}")
        if zpath.suffix != ".zip":
            raise ValueError(f"expected .zip file, got: {zpath.suffix}")

        with tempfile.TemporaryDirectory(prefix="skillbot-install-") as tmp:
            with zipfile.ZipFile(zpath, "r") as zf:
                zf.extractall(tmp)

            tmp_path = Path(tmp)
            entries = [e for e in tmp_path.iterdir()
                       if e.name not in ("__MACOSX",) and not e.name.startswith("._")]

            if not entries:
                raise ValueError("zip is empty")

            # Find the skill root: if zip extracts a single dir, use it;
            # otherwise use the extraction dir itself
            if len(entries) == 1 and entries[0].is_dir():
                skill_root = entries[0]
            else:
                skill_root = tmp_path

            name = skill_root.name
            if name.startswith(".") or name in ("__pycache__",):
                raise ValueError(f"invalid skill name: {name}")

            # Find SKILL.md case-insensitively
            skill_md = self._find_skill_md(skill_root)
            if not skill_md:
                files = [f.name for f in skill_root.iterdir()] if skill_root.is_dir() else []
                raise ValueError(
                    f"SKILL.md not found. Contents: {files or '(empty directory)'}"
                )

            # Parse to validate frontmatter (strict at the install boundary)
            info = self._parse_skill(skill_md, recover=False)
            if not info:
                raise ValueError("SKILL.md has invalid or missing YAML frontmatter")

            # Clean macOS resource forks before install
            _clean_macos_junk(skill_root)

            # Install
            self._dir.mkdir(parents=True, exist_ok=True)
            dest = self._dir / name
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(skill_root, dest)
            _log.info("skill installed: %s (%d files)", name,
                       len(list(dest.rglob("*"))))

        # New skills default to enabled
        self._disabled.discard(name)
        self._save_state()

        return SkillInfo(name=info.name, description=info.description,
                         path=str(dest), enabled=True)

    def uninstall(self, name: str) -> None:
        """Remove an installed skill."""
        dest = self._dir / name
        if not dest.is_dir():
            raise FileNotFoundError(f"skill not found: {name}")
        shutil.rmtree(dest)
        self._disabled.discard(name)
        self._save_state()
        _log.info("skill uninstalled: %s", name)

    # ------------------------------------------------------------------
    # enable / disable (persisted)
    # ------------------------------------------------------------------

    def enable(self, name: str) -> None:
        """Enable a skill. Persisted to disk and bridged to config.yaml."""
        if not self._locate_skill_dir(name):
            raise FileNotFoundError(f"skill not installed: {name}")
        self._disabled.discard(name)
        self._save_state()
        self._sync_disabled_to_config()
        _log.info("skill enabled: %s", name)

    def disable(self, name: str) -> None:
        """Disable a skill. Persisted to disk and bridged to config.yaml."""
        if not self._locate_skill_dir(name):
            raise FileNotFoundError(f"skill not installed: {name}")
        self._disabled.add(name)
        self._save_state()
        self._sync_disabled_to_config()
        _log.info("skill disabled: %s", name)

    # ------------------------------------------------------------------
    # config.yaml bridge — the agent runtime (hermes) reads its disabled
    # list from ~/.hermes/config.yaml ``skills.disabled``, NOT from
    # .skill_state.json. Mirror our disabled set there so toggling in the UI
    # actually changes what the agent loads (on the next session).
    # ------------------------------------------------------------------

    @property
    def _config_path(self) -> Path:
        """Sibling config.yaml (e.g. ~/.hermes/skills → ~/.hermes/config.yaml)."""
        return self._dir.parent / "config.yaml"

    def _sync_disabled_to_config(self) -> None:
        """Best-effort mirror of ``self._disabled`` into config.yaml.

        Splices only the top-level ``skills:`` block so every other comment and
        setting in the file is preserved. Silently no-ops when there is no
        config.yaml (e.g. non-hermes agents or a bare install).
        """
        cfg = self._config_path
        if not cfg.is_file():
            return
        try:
            text = cfg.read_text(encoding="utf-8")
            data = yaml.safe_load(text) or {}
            skills_cfg = data.get("skills")
            skills_cfg = dict(skills_cfg) if isinstance(skills_cfg, dict) else {}
            skills_cfg["disabled"] = sorted(self._disabled)
            block = yaml.safe_dump({"skills": skills_cfg},
                                   default_flow_style=False, sort_keys=False).rstrip("\n")
            new_text = _splice_top_level_block(text, "skills", block)
            cfg.write_text(new_text, encoding="utf-8")
            _log.info("synced skills.disabled → %s (%d disabled)",
                      cfg, len(self._disabled))
        except Exception as e:  # never let a config write break a toggle
            _log.warning("config.yaml sync failed: %s", e)

    @property
    def active_skills(self) -> list[str]:
        """Return enabled skill names."""
        installed = {s.name for s in self.list_skills()}
        return sorted(installed - self._disabled)

    @property
    def disabled_skills(self) -> list[str]:
        """Return disabled skill names (only for currently installed skills)."""
        installed = {s.name for s in self.list_skills()}
        return sorted(self._disabled & installed)

    # ------------------------------------------------------------------
    # retrieval (keyword)
    # ------------------------------------------------------------------

    def retrieve(
        self, query: str, top_k: int = 5, skills: list[str] | None = None
    ) -> list[tuple[str, float]]:
        """Rank skills by keyword relevance to *query* (TF-IDF over name+description).

        Returns ``[(skill_name, score), ...]`` sorted by score desc, limited to
        *top_k*. Only skills with a positive score are returned, so an unrelated
        query yields fewer (or zero) results. Candidate pool defaults to all
        enabled skills; pass *skills* to restrict it.

        Keyword-only on purpose — no embedding model in this env. Skill name
        tokens are weighted higher since the name is the strongest signal.
        """
        infos = {s.name: s for s in self.list_skills()}
        if skills is not None:
            pool = [infos[n] for n in skills if n in infos]
        else:
            pool = [s for s in infos.values() if s.enabled]
        if not pool:
            return []

        docs: dict[str, list[str]] = {}
        for info in pool:
            name_toks = _tokenize(info.name)
            desc_toks = _tokenize(info.description or "")
            # weight name tokens higher (repeat) — name is the strongest signal
            docs[info.name] = name_toks * 3 + desc_toks

        n_docs = len(docs)
        df: dict[str, int] = {}
        for toks in docs.values():
            for t in set(toks):
                df[t] = df.get(t, 0) + 1
        idf = {t: math.log(1 + n_docs / (1 + c)) for t, c in df.items()}

        q_tokens = set(_tokenize(query))
        scored: list[tuple[str, float]] = []
        for name, toks in docs.items():
            tf: dict[str, int] = {}
            for t in toks:
                tf[t] = tf.get(t, 0) + 1
            score = sum(tf[t] * idf.get(t, 0.0) for t in q_tokens if t in tf)
            if score > 0:
                scored.append((name, score))
        scored.sort(key=lambda x: -x[1])
        return scored[:top_k]

    # ------------------------------------------------------------------
    # rerank (LLM, semantic)
    # ------------------------------------------------------------------

    def rerank(
        self,
        query: str,
        candidates: list[str],
        top_k: int | None = None,
        timeout: int = 20,
    ) -> list[str]:
        """Reorder keyword *candidates* by semantic fit using a chat LLM.

        Keyword retrieval misses when the query and a skill's description share
        no surface tokens (e.g. "拼出带特征的训练集" vs a description that says
        "JOIN/特征拼接"). There is no reachable embedding API in this env, so we
        approximate semantic recall by asking DeepSeek chat to rank the
        candidate names — descriptions included as context — for the query.

        Returns reordered names (best first), truncated to *top_k* if given.
        On any failure (no key, network, timeout, bad output) the original
        *candidates* order is returned unchanged — rerank is best-effort.
        """
        if not candidates:
            return []
        if len(candidates) == 1:
            return candidates[:top_k] if top_k else candidates

        key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
        if not key:
            _log.debug("rerank skipped: DEEPSEEK_API_KEY not set")
            return candidates[:top_k] if top_k else candidates

        infos = {s.name: s for s in self.list_skills()}
        lines = []
        for name in candidates:
            desc = (infos[name].description if name in infos else "") or ""
            lines.append(f"- {name}: {desc[:200]}")
        catalog = "\n".join(lines)
        names_json = json.dumps(candidates, ensure_ascii=False)
        prompt = (
            "You are a skill router. Given a user request and a list of candidate "
            "skills (name: description), rank the candidates from most to least "
            "relevant to the request.\n\n"
            f"User request:\n{query}\n\n"
            f"Candidate skills:\n{catalog}\n\n"
            "Respond with ONLY a JSON array of the skill names, ordered best "
            f"first. Use exactly these names: {names_json}. No prose, no code fence."
        )

        try:
            ranked = self._deepseek_rank(prompt, key, timeout)
        except Exception as exc:  # network, timeout, decode — all best-effort
            _log.warning("rerank failed, falling back to keyword order (%s)", exc)
            return candidates[:top_k] if top_k else candidates

        # Keep only known names, dedup preserving order, then append any
        # candidate the model dropped so we never lose recall.
        seen: set[str] = set()
        out: list[str] = []
        cand_set = set(candidates)
        for n in ranked:
            if n in cand_set and n not in seen:
                out.append(n)
                seen.add(n)
        for n in candidates:
            if n not in seen:
                out.append(n)
                seen.add(n)
        return out[:top_k] if top_k else out

    @staticmethod
    def _deepseek_rank(prompt: str, key: str, timeout: int) -> list[str]:
        """Call DeepSeek chat and parse a JSON array of skill names."""
        body = json.dumps({
            "model": _DEEPSEEK_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
            "max_tokens": 256,
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{_DEEPSEEK_BASE}/chat/completions",
            data=body,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
        content = data["choices"][0]["message"]["content"].strip()
        # Tolerate a ```json fence if the model adds one despite instructions.
        m = re.search(r"\[.*\]", content, re.DOTALL)
        if not m:
            raise ValueError(f"no JSON array in response: {content[:120]!r}")
        parsed = json.loads(m.group(0))
        if not isinstance(parsed, list):
            raise ValueError("parsed JSON is not a list")
        return [str(x) for x in parsed]

    # ------------------------------------------------------------------
    # prompt injection
    # ------------------------------------------------------------------

    def inject_prompt(
        self,
        skills: list[str] | None = None,
        progressive: bool = False,
        query: str | None = None,
        top_k: int = 5,
        rerank: bool = False,
        rerank_pool: int = 10,
    ) -> str:
        """Build a prompt injection string for the given skills.

        Used by agents without native skill support (deer-flow, nanobot,
        hermes-agent). The returned text should be prepended to the
        user message or injected into the system prompt.

        If *skills* is None, all active (enabled) skills are injected.

        When *progressive* is True, only a routing layer is injected per
        skill (``name + description + SKILL.md path``) plus an instruction
        telling the agent to read the file on demand, instead of the full
        body. This keeps the prompt small when many skills are enabled — the
        body and ``references/`` are loaded lazily via the agent's file-read
        tool once it has decided which skill to use.

        When *query* is given, keyword retrieval narrows the catalog to the
        *top_k* most relevant skills before injection, so the routing layer
        only carries plausible candidates instead of every skill.

        When *rerank* is True (requires *query*), keyword first widens to a
        *rerank_pool* candidate set, then an LLM reorders it semantically and
        the result is truncated to *top_k*. This rescues skills whose
        description shares no surface tokens with the query. Rerank is
        best-effort — on any failure it falls back to keyword order.
        """
        # Scan once — collect all skill info
        all_skills = {s.name: s for s in self.list_skills()}
        if skills is not None:
            names = skills
        else:
            names = [s.name for s in all_skills.values() if s.enabled]
        if query:
            pool = max(top_k, rerank_pool) if rerank else top_k
            ranked = self.retrieve(query, top_k=pool, skills=names)
            if ranked:
                cand = [name for name, _ in ranked]
                if rerank:
                    cand = self.rerank(query, cand, top_k=top_k)
                names = cand
        disabled = {name for name, s in all_skills.items() if not s.enabled}
        if not names and not disabled:
            return ""
        parts: list[str] = []
        per_skill_tokens: list[tuple[str, int]] = []
        for name in names:
            info = all_skills.get(name)
            if not info:
                continue
            if progressive:
                # Routing layer only: name + description + how to load.
                if not info.description:
                    continue
                entry = (
                    f"## {info.name}\n"
                    f"{info.description.strip()}\n"
                    f"To use this skill, read its full instructions: {info.path}/SKILL.md"
                )
                parts.append(entry)
                per_skill_tokens.append((info.name, _est_tokens(entry)))
            elif info.body:
                entry = f"# Skill: {info.name}\n{info.body}"
                parts.append(entry)
                per_skill_tokens.append((info.name, _est_tokens(entry)))
        result_parts: list[str] = []
        if parts:
            if progressive:
                result_parts.append(
                    "[System: The following skills are available. Each entry lists its "
                    "name, when to use it, and where to read its full instructions. "
                    "Only read a skill's SKILL.md when you decide to use it.]\n\n"
                    + "\n\n".join(parts)
                )
            else:
                result_parts.append(
                    "[System: The following skills are active for this conversation]\n\n"
                    + "\n\n---\n\n".join(parts)
                )
        if disabled:
            result_parts.append(
                "[System: The following skills are DISABLED and must NOT be used: "
                + ", ".join(sorted(disabled)) + "]"
            )
        result = "\n\n".join(result_parts) if result_parts else ""

        self._log_injection_cost(progressive, per_skill_tokens, result)
        return result

    @staticmethod
    def _log_injection_cost(
        progressive: bool, per_skill_tokens: list[tuple[str, int]], result: str
    ) -> None:
        """Log per-skill and total token cost of this injection."""
        if not per_skill_tokens:
            return
        mode = "progressive" if progressive else "full"
        total = _est_tokens(result)
        body_total = sum(t for _, t in per_skill_tokens)
        _log.info(
            "skill injection [%s]: %d skills, ~%d tokens total (%d in skill entries)",
            mode, len(per_skill_tokens), total, body_total,
        )
        for sk_name, tok in sorted(per_skill_tokens, key=lambda x: -x[1]):
            pct = (tok * 100 // body_total) if body_total else 0
            _log.debug("  skill %-40s ~%6d tokens (%2d%%)", sk_name, tok, pct)

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_skill(md_file: Path, recover: bool = True) -> SkillInfo | None:
        """Parse a SKILL.md file and return SkillInfo, or None.

        When the frontmatter is malformed (missing ``---`` fences or invalid
        YAML) and ``recover`` is True (the default, used by the *load* path),
        the loader does NOT silently drop the skill: it emits a WARNING and
        falls back to :meth:`_recover_metadata`, which best-effort scrapes
        ``name`` / ``description`` from the raw text so a broken-but-present
        SKILL.md still enters the candidate pool.

        The *install* path passes ``recover=False`` so a malformed upload is
        rejected loudly at the boundary (returns ``None`` → caller raises).
        """
        try:
            text = md_file.read_text(encoding="utf-8")
        except Exception as exc:
            _log.warning("skill skipped: cannot read %s (%s)", md_file, exc)
            return None

        m = _FRONTMATTER_RE.match(text)
        if not m:
            if not recover:
                return None
            _log.warning(
                "%s has no valid '---' YAML frontmatter block; "
                "recovering metadata best-effort (fix the file to silence this)",
                md_file,
            )
            return SkillManager._recover_metadata(md_file, text)
        try:
            meta = yaml.safe_load(m.group(1)) or {}
        except Exception as exc:
            if not recover:
                return None
            _log.warning(
                "%s has malformed YAML frontmatter (%s); "
                "recovering metadata best-effort",
                md_file, exc,
            )
            return SkillManager._recover_metadata(md_file, text)

        name = meta.get("name", md_file.parent.name)
        description = meta.get("description", "")
        body = text[m.end():].strip()
        return SkillInfo(
            name=name,
            description=description,
            path=str(md_file.parent),
            body=body,
        )

    @staticmethod
    def _recover_metadata(md_file: Path, text: str) -> SkillInfo | None:
        """Scrape name/description from a SKILL.md with broken frontmatter.

        Handles the two real corruption patterns seen in the wild:
        pure-YAML files with no ``---`` fences, and markdown-escaped
        underscores (``rule\\_generate``) / stray ``***`` or long-dash noise
        lines. Never crashes; returns ``None`` only if no name can be found.
        """
        name = ""
        description = ""
        for raw in text.splitlines():
            line = raw.replace("\\_", "_").strip()
            # skip separator/noise lines: ***, ------, ---, list bullets
            if not line or set(line) <= {"*", "-", " "}:
                continue
            if not name:
                mo = re.match(r"^-?\s*name\s*:\s*(.+)$", line, re.IGNORECASE)
                if mo:
                    name = mo.group(1).strip().strip("'\"")
                    continue
            if not description:
                mo = re.match(r"^-?\s*description\s*:\s*(.+)$", line, re.IGNORECASE)
                if mo:
                    description = mo.group(1).strip().strip("'\"")
            if name and description:
                break

        if not name:
            name = md_file.parent.name
        if not name:
            _log.warning("skill skipped: %s has no recoverable name", md_file)
            return None
        return SkillInfo(
            name=name,
            description=description,
            path=str(md_file.parent),
            body=text.strip(),
        )
