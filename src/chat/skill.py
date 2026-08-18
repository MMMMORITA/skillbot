"""Cross-agent skill management — install, list, uninstall, prompt injection."""

from __future__ import annotations

import json
import logging
import re
import shutil
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path

import yaml

_log = logging.getLogger(__name__)

_FRONTMATTER_RE = re.compile(r"^---\s*\r?\n(.*?)\r?\n---\s*(?:\r?\n|$)", re.DOTALL)
_STATE_FILE = ".skill_state.json"

# Skills are discovered recursively, so a categorized layout
# (``<dir>/<category>/<skill>/SKILL.md``, e.g. hermes-agent) can hold dozens of
# skills. Enabling every one by default would inject hundreds of thousands of
# tokens of skill bodies into every message, so for *categorized* layouts only
# these categories are enabled by default. Flat layouts (e.g. claude-code's
# ``.claude/skills/<skill>/SKILL.md``) are unaffected and stay all-enabled.
_DEFAULT_ENABLED_CATEGORIES = {"software-development", "custom"}


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


class SkillManager:
    """Manage skills in a directory: list, install from .zip, uninstall.

    Enable/disable state is persisted in ``.skill_state.json`` inside the
    skill directory. Explicit installs default to enabled; recursively
    discovered categorized skills follow the category policy above.
    """

    def __init__(self, skill_dir: str) -> None:
        self._dir = Path(skill_dir)
        self._disabled: set[str] = set()
        self._enabled: set[str] = set()   # skills the user explicitly enabled (overrides default policy)
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
            self._enabled = set(data.get("enabled", []))
        except Exception:
            self._disabled = set()
            self._enabled = set()

    def _save_state(self) -> None:
        if not self._dir.is_dir():
            self._dir.mkdir(parents=True, exist_ok=True)
        self._state_path.write_text(
            json.dumps(
                {"disabled": sorted(self._disabled), "enabled": sorted(self._enabled)},
                indent=2,
            ),
            encoding="utf-8",
        )

    # ------------------------------------------------------------------
    # discovery
    # ------------------------------------------------------------------

    def list_skills(self) -> list[SkillInfo]:
        """List all installed skills with enable status.

        Discovery is recursive: both a flat layout
        (``<dir>/<skill>/SKILL.md``) and a categorized one
        (``<dir>/<category>/<skill>/SKILL.md``) are supported.
        """
        skills: list[SkillInfo] = []
        if not self._dir.is_dir():
            return skills
        for md in self._discover_skill_mds():
            info = self._parse_skill(md)
            if info:
                info.enabled = self._is_enabled(info.name, md)
                skills.append(info)
        skills.sort(key=lambda s: s.name.lower())
        return skills

    def _discover_skill_mds(self) -> list[Path]:
        """Recursively find every SKILL.md under the skill directory.

        A directory that directly contains a SKILL.md is treated as a skill
        root; recursion does not descend into it (skills don't nest inside
        skills). Hidden dirs (``.git``, ``.skill_state.json`` parent, etc.) are
        skipped.
        """
        found: list[Path] = []

        def _walk(d: Path) -> None:
            try:
                entries = sorted(d.iterdir())
            except Exception:
                return
            md = self._find_skill_md(d)
            if md is not None:
                found.append(md)
                return  # this dir IS a skill — don't recurse into it
            for e in entries:
                if e.is_dir() and not e.name.startswith(".") and e.name != "__pycache__":
                    _walk(e)

        _walk(self._dir)
        return found

    def _is_enabled(self, name: str, md: Path) -> bool:
        """Default-enable policy for a discovered skill.

        Explicit user state in ``.skill_state.json`` always wins. For skills the
        user hasn't touched:

        * **Flat** layout (every skill sits directly under ``_dir``, e.g.
          claude-code) → all enabled.
        * **Categorized** layout (skills live under ``_dir/<category>/...``,
          e.g. hermes-agent) → only skills whose top-level category is in
          :data:`_DEFAULT_ENABLED_CATEGORIES` are enabled. A skill placed
          directly under ``_dir`` in an otherwise-categorized tree (e.g.
          ``yuanbao``) is treated as an uncategorized skill and left disabled,
          so injection stays bounded.
        """
        if name in self._disabled:
            return False
        if name in self._enabled:
            return True
        # Not explicitly set by the user — apply default policy.
        try:
            rel = md.parent.relative_to(self._dir)
        except Exception:
            return True
        parts = rel.parts
        if not self._is_categorized():
            return True  # flat layout → enable everything
        if len(parts) <= 1:
            return False  # uncategorized skill in a categorized tree → off by default
        return parts[0] in _DEFAULT_ENABLED_CATEGORIES

    def _is_categorized(self) -> bool:
        """True if this skill dir uses a nested ``<category>/<skill>`` layout.

        A layout is categorized if any discovered SKILL.md is more than one
        level below ``_dir``. The cache is invalidated when this manager mutates
        the tree through install/uninstall.
        """
        cached = getattr(self, "_categorized_cache", None)
        if cached is not None:
            return cached
        result = False
        for md in self._discover_skill_mds():
            try:
                if len(md.parent.relative_to(self._dir).parts) > 1:
                    result = True
                    break
            except Exception:
                continue
        self._categorized_cache = result
        return result

    def _find_skill_md(self, skill_dir: Path) -> Path | None:
        """Find SKILL.md directly inside a directory, case-insensitive."""
        if not skill_dir.is_dir():
            return None
        try:
            for f in skill_dir.iterdir():
                if f.is_file() and f.name.lower() == "skill.md":
                    return f
        except Exception:
            return None
        return None

    def _find_skill_md_by_name(self, name: str) -> Path | None:
        """Locate a skill's SKILL.md by its (unique) name, searching recursively."""
        for md in self._discover_skill_mds():
            info = self._parse_skill(md)
            if info and info.name == name:
                return md
        # Fall back to directory-name match for skills without a name in frontmatter.
        for md in self._discover_skill_mds():
            if md.parent.name == name:
                return md
        return None

    def get_skill(self, name: str) -> SkillInfo | None:
        """Get a single skill by name (recursive lookup)."""
        md = self._find_skill_md_by_name(name)
        if not md:
            return None
        info = self._parse_skill(md)
        if info:
            info.enabled = self._is_enabled(info.name, md)
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

            # Parse to validate frontmatter
            info = self._parse_skill(skill_md)
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
            self._categorized_cache = None
            _log.info("skill installed: %s (%d files)", name,
                       len(list(dest.rglob("*"))))

        # New skills default to enabled
        self._disabled.discard(info.name)
        self._enabled.add(info.name)
        self._save_state()

        return SkillInfo(name=info.name, description=info.description,
                         path=str(dest), enabled=True)

    def uninstall(self, name: str) -> None:
        """Remove an installed skill."""
        md = self._find_skill_md_by_name(name)
        dest = md.parent if md else (self._dir / name)
        if not dest.is_dir():
            raise FileNotFoundError(f"skill not found: {name}")
        shutil.rmtree(dest)
        self._categorized_cache = None
        self._disabled.discard(name)
        self._enabled.discard(name)
        self._save_state()
        _log.info("skill uninstalled: %s", name)

    # ------------------------------------------------------------------
    # enable / disable (persisted)
    # ------------------------------------------------------------------

    def enable(self, name: str) -> None:
        """Enable a skill. Persisted to disk."""
        if not self._find_skill_md_by_name(name):
            raise FileNotFoundError(f"skill not installed: {name}")
        self._disabled.discard(name)
        self._enabled.add(name)   # explicit override of the default-enable policy
        self._save_state()
        _log.info("skill enabled: %s", name)

    def disable(self, name: str) -> None:
        """Disable a skill. Persisted to disk."""
        if not self._find_skill_md_by_name(name):
            raise FileNotFoundError(f"skill not installed: {name}")
        self._disabled.add(name)
        self._enabled.discard(name)
        self._save_state()
        _log.info("skill disabled: %s", name)

    @property
    def active_skills(self) -> list[str]:
        """Return enabled skill names."""
        return sorted(s.name for s in self.list_skills() if s.enabled)

    @property
    def disabled_skills(self) -> list[str]:
        """Return disabled skill names (only for currently installed skills)."""
        return sorted(s.name for s in self.list_skills() if not s.enabled)

    # ------------------------------------------------------------------
    # prompt injection
    # ------------------------------------------------------------------

    def inject_prompt(self, skills: list[str] | None = None) -> str:
        """Build a prompt injection string for the given skills.

        Used by agents without native skill support (deer-flow, nanobot,
        hermes-agent). The returned text should be prepended to the
        user message or injected into the system prompt.

        If *skills* is None, all active (enabled) skills are injected.
        """
        # Scan once — collect all skill info
        all_skills = {s.name: s for s in self.list_skills()}
        if skills is not None:
            names = skills
        else:
            names = [s.name for s in all_skills.values() if s.enabled]
        disabled = {name for name, s in all_skills.items() if not s.enabled}
        if not names and not disabled:
            return ""
        parts: list[str] = []
        for name in names:
            info = all_skills.get(name)
            if info and info.body:
                parts.append(f"# Skill: {info.name}\n{info.body}")
        result_parts: list[str] = []
        if parts:
            result_parts.append(
                "[System: The following skills are active for this conversation]\n\n"
                + "\n\n---\n\n".join(parts)
            )
        if disabled:
            result_parts.append(
                "[System: The following skills are DISABLED and must NOT be used: "
                + ", ".join(sorted(disabled)) + "]"
            )
        return "\n\n".join(result_parts) if result_parts else ""

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_skill(md_file: Path) -> SkillInfo | None:
        """Parse a SKILL.md file and return SkillInfo, or None."""
        try:
            text = md_file.read_text(encoding="utf-8")
        except Exception:
            return None

        m = _FRONTMATTER_RE.match(text)
        if not m:
            return None
        try:
            meta = yaml.safe_load(m.group(1)) or {}
        except Exception:
            return None

        name = meta.get("name", md_file.parent.name)
        description = meta.get("description", "")
        body = text[m.end():].strip()
        return SkillInfo(
            name=name,
            description=description,
            path=str(md_file.parent),
            body=body,
        )
