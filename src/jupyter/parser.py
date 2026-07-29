"""BlockParser — extract structured output from agent text into ParsedResult."""

import json
import logging
import re
from dataclasses import dataclass, field

_log = logging.getLogger(__name__)

_JSON_FENCE = re.compile(
    r"```json\s*\n(.*?)\n```",
    re.MULTILINE | re.DOTALL,
)

_CODE_FENCE = re.compile(
    r"(?:^|\n)```(?:\w+)?[ \t]*\n(.*?)\n```",
    re.MULTILINE | re.DOTALL,
)

_MD_PATTERNS = (
    re.compile(r'^#{1,6}\s', re.MULTILINE),
    re.compile(r'\*\*.*\*\*'),
    re.compile(r'^[-*+]\s', re.MULTILINE),
    re.compile(r'^\d+\.\s', re.MULTILINE),
    re.compile(r'`[^`]+`'),
    re.compile(r'^\|.*\|', re.MULTILINE),
    re.compile(r'^> ', re.MULTILINE),
)


def _has_markdown(text: str) -> bool:
    return any(p.search(text) for p in _MD_PATTERNS)


@dataclass
class ParsedResult:
    text: str = ""
    csv: dict[str, str] = field(default_factory=dict)
    images: list[bytes] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    code_list: list[str] = field(default_factory=list)
    plan: str = ""
    decision_gate: dict | None = None
    is_markdown: bool = False


def parse(text: str) -> ParsedResult:
    """Parse agent output with cascading fallback.

    Priority: JSON fenced → raw JSON → code fenced → raw text.
    Unparseable content at each level is placed in ``.text`` and a warning
    is logged; the function never raises.
    """
    from .render import render_debug
    render_debug(f"parse input ({len(text)} chars)")
    _log.debug(text[:5000])

    # 1. JSON fenced block: ```json ... ```
    m = _JSON_FENCE.search(text)
    if m:
        try:
            data = json.loads(m.group(1))
        except json.JSONDecodeError:
            _log.warning("parse: invalid JSON in fenced block, falling back")
            return _from_code_fence_or_text(text)
        return _from_json(data)

    # 2. Raw JSON: { ... }
    stripped = text.strip()
    if stripped.startswith("{"):
        try:
            data = json.loads(stripped)
        except json.JSONDecodeError:
            _log.warning("parse: invalid raw JSON, falling back")
            return _from_code_fence_or_text(text)
        return _from_json(data)

    # 3. Code fence + 4. raw text
    return _from_code_fence_or_text(text)


def _from_json(data: dict) -> ParsedResult:
    """Build ParsedResult from parsed JSON dict."""
    result = ParsedResult()
    result.text = data.get("text", "")
    result.plan = data.get("plan", "")
    code_raw = data.get("code", "")
    if isinstance(code_raw, list):
        result.code_list = [str(c) for c in code_raw if str(c).strip()]
    elif isinstance(code_raw, str) and code_raw.strip():
        result.code_list = [code_raw.strip()]
    result.files = [str(f) for f in data.get("files", [])]
    result.decision_gate = _normalize_gate(data.get("decision_gate"))
    if result.text:
        result.is_markdown = _has_markdown(result.text)
    return result


def _normalize_gate(raw) -> dict | None:
    """Validate a decision_gate object; return normalized dict or None.

    A gate is only honored when it carries at least one option with a label —
    otherwise the frontend would render an empty, un-actionable card. Malformed
    gates are dropped (logged), never raised.
    """
    if not isinstance(raw, dict):
        if raw is not None:
            _log.warning("parse: decision_gate is %s, not object — ignored", type(raw).__name__)
        return None
    opts_raw = raw.get("options")
    if not isinstance(opts_raw, list) or not opts_raw:
        _log.warning("parse: decision_gate has no options list — ignored")
        return None
    options: list[dict] = []
    for o in opts_raw:
        if not isinstance(o, dict):
            continue
        label = str(o.get("label", "")).strip()
        if not label:
            continue
        options.append({
            "label": label,
            "evidence": str(o.get("evidence", "")).strip(),
            "recommended": bool(o.get("recommended", False)),
        })
    if not options:
        _log.warning("parse: decision_gate options all empty — ignored")
        return None
    gtype = str(raw.get("type", "")).strip() or "direction"
    return {
        "type": gtype,
        "question": str(raw.get("question", "")).strip(),
        "options": options,
    }


def _from_code_fence_or_text(text: str) -> ParsedResult:
    """Extract code from `` ```python ``` `` or bare `` ``` ``` `` blocks.

    Code blocks populate ``code_list``; surrounding text goes to ``.text``.
    If no code fences are found, the whole *text* is placed in ``.text``.
    """
    result = ParsedResult()
    matches = list(_CODE_FENCE.finditer(text))
    if not matches:
        _log.warning("parse: no structured content found (%d chars):\n%s", len(text), text[:2000])
        result.text = text
        if result.text:
            result.is_markdown = _has_markdown(result.text)
        return result

    # text segments between code blocks
    text_parts: list[str] = []
    last_end = 0
    for m in matches:
        before = text[last_end:m.start()].strip()
        if before:
            text_parts.append(before)
        result.code_list.append(m.group(1).strip())
        last_end = m.end()
    after = text[last_end:].strip()
    if after:
        text_parts.append(after)
    result.text = "\n\n".join(text_parts)
    if result.text:
        result.is_markdown = _has_markdown(result.text)
    _log.warning("parse: %d code fence(s) extracted, no JSON", len(matches))
    return result


def traceback_line(tb) -> int:
    """Return the source line number from the LAST frame of a traceback."""
    import traceback
    frames = traceback.extract_tb(tb)
    return frames[-1].lineno if frames else 10**9
