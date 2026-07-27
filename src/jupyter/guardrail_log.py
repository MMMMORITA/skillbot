"""Durable guardrail-violation log — append-on-write JSONL, multi-instance aware.

When a hard guardrail fires (e.g. the agent tried to hide real code in a
home-dir ``.py`` and load it via ``exec(open(...))``), we want a *queryable*
record so "how often does the model misbehave?" becomes a number, not a hunch.

Why a separate log rather than reusing ``SessionEventRecorder``: that recorder
is buffered in memory and only flushed at session end, and the guardrail fires
inside ``render.render_code`` where there may be no live recorder at all. A
guardrail hit is exactly the kind of event we cannot afford to lose on a crash
or a missing session, so this writes append-on-write (one ``open(..., "a")``
per hit) — the same durability the playbook store uses. Best-effort: any I/O
failure is swallowed so logging never breaks a cell render.

Multi-instance / multi-user deployment
--------------------------------------
skillbot is deployed as several JupyterLab servers on different ports off the
*same* repo checkout, so a single shared log file would blend every user's
violations into one anonymous stream. Instead:

* every record auto-captures an identity — ``instance`` (a per-server label,
  derived from ``SKILLBOT_INSTANCE`` / ``SKILLBOT_PORT`` the launcher exports),
  ``user`` (``SKILLBOT_USER`` or the OS user) and ``pid``;
* each instance writes its own file at
  ``<repo>/.run/guardrail/<instance>.jsonl`` so per-user history stays
  physically separate and is trivially ``tail -f``-able per port;
* reads accept ``scope="all"`` to merge every instance file (plus any legacy
  single-file log) into one timeline for a cross-user view;
* if ``SKILLBOT_GUARDRAIL_WEBHOOK`` is set, each record is also POSTed
  (fire-and-forget, off-thread) to that URL — the seam to a central collector
  such as self-hosted Langfuse / an OTEL log sink for real-time tracking.
"""

from __future__ import annotations

import getpass
import json
import logging
import os
import re
import threading
from datetime import datetime
from pathlib import Path

_log = logging.getLogger("jupyter.guardrail")

# Legacy single-file location (pre multi-instance). Still read for continuity.
_LEGACY_NAME = "guardrail_violations.jsonl"

_SLUG_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _slug(value: str) -> str:
    """Filesystem-safe label (keeps a stable, human-readable instance name)."""
    s = _SLUG_RE.sub("-", str(value).strip()).strip("-")
    return s or "default"


def _instance_id() -> str:
    """Per-server label used both in records and as the log filename stem.

    Precedence: explicit ``SKILLBOT_INSTANCE`` > ``port-<SKILLBOT_PORT>`` (the
    launcher exports the port so co-located servers stay distinct) > ``default``.
    """
    explicit = os.environ.get("SKILLBOT_INSTANCE")
    if explicit:
        return _slug(explicit)
    port = os.environ.get("SKILLBOT_PORT")
    if port:
        return _slug(f"port-{port}")
    return "default"


def _user_id() -> str:
    """Owner of this instance — ``SKILLBOT_USER`` override, else the OS user."""
    val = os.environ.get("SKILLBOT_USER")
    if val:
        return val
    try:
        return getpass.getuser() or "unknown"
    except Exception:
        return "unknown"


def _run_root() -> Path:
    """``<repo>/.run`` — same root as the playbook and session telemetry."""
    return Path(__file__).resolve().parents[2] / ".run"


def _log_dir() -> Path:
    """``<repo>/.run/guardrail`` — one JSONL per instance lives here."""
    return _run_root() / "guardrail"


def _default_path() -> Path:
    """This instance's log: ``<repo>/.run/guardrail/<instance>.jsonl``."""
    return _log_dir() / f"{_instance_id()}.jsonl"


def _legacy_path() -> Path:
    """Pre multi-instance single-file log, kept readable for continuity."""
    return _run_root() / _LEGACY_NAME


def _all_paths() -> list[Path]:
    """Every instance file (+ legacy single file if present), for scope=all."""
    paths: list[Path] = []
    d = _log_dir()
    if d.is_dir():
        paths.extend(sorted(d.glob("*.jsonl")))
    legacy = _legacy_path()
    if legacy.is_file():
        paths.append(legacy)
    return paths


def _maybe_forward(entry: dict) -> None:
    """Fire-and-forget POST to ``SKILLBOT_GUARDRAIL_WEBHOOK`` if configured.

    Off-thread with a short timeout so a slow/unreachable collector can never
    stall a cell render. This is the integration seam for a central, real-time
    cross-user view (Langfuse ingestion, an OTEL/HTTP log sink, etc.).
    """
    url = os.environ.get("SKILLBOT_GUARDRAIL_WEBHOOK")
    if not url:
        return

    def _send() -> None:
        try:
            import urllib.request

            data = json.dumps(entry, ensure_ascii=False, default=str).encode("utf-8")
            req = urllib.request.Request(
                url, data=data, headers={"Content-Type": "application/json"}
            )
            urllib.request.urlopen(req, timeout=2)  # noqa: S310 (operator-supplied URL)
        except Exception as exc:  # never raise — telemetry must not break renders
            _log.debug("guardrail webhook forward failed: %s", exc)

    try:
        threading.Thread(target=_send, name="guardrail-forward", daemon=True).start()
    except Exception:
        pass


def record_violation(kind: str, **fields) -> None:
    """Append one guardrail-violation record to this instance's durable log.

    ``kind`` is a short machine tag (e.g. ``hidden_script_inlined``). Identity
    fields (``instance``/``user``/``pid``) are auto-captured so multi-user
    deployments can attribute each hit; explicit ``fields`` win on conflict.
    Always best-effort — never raises.
    """
    entry = {
        "timestamp": datetime.now().isoformat(),
        "kind": kind,
        "instance": _instance_id(),
        "user": _user_id(),
        "pid": os.getpid(),
        **fields,
    }
    try:
        json.dumps(entry, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        entry = {"timestamp": entry["timestamp"], "kind": kind,
                 "instance": entry.get("instance"), "user": entry.get("user"),
                 "serialization_error": True}
    try:
        path = _default_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
    except OSError as exc:
        _log.warning("guardrail log write failed: %s", exc)
    _maybe_forward(entry)


def _read_file(path: Path) -> list[dict]:
    """Parse one JSONL log file, skipping malformed lines. Missing file → []."""
    if not path.is_file():
        return []
    out: list[dict] = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except (TypeError, ValueError):
                    continue
    except OSError as exc:
        _log.warning("guardrail log read failed: %s", exc)
        return []
    return out


def read_violations(limit: int | None = None, scope: str = "instance") -> list[dict]:
    """Read recorded violations (oldest first). Bad lines are skipped.

    ``scope="instance"`` (default) reads only this server's log; ``scope="all"``
    merges every instance file (+ legacy) into one timeline sorted by timestamp.
    ``limit`` returns only the most recent N when set.
    """
    if scope == "all":
        rows: list[dict] = []
        for p in _all_paths():
            rows.extend(_read_file(p))
        rows.sort(key=lambda r: str(r.get("timestamp", "")))
    else:
        rows = _read_file(_default_path())
    if limit is not None and limit >= 0:
        return rows[-limit:]
    return rows


def summarize(scope: str = "instance") -> dict:
    """Aggregate into counts by kind + total, for a quick "misbehaviour rate".

    Adds ``by_instance`` / ``by_user`` breakdowns so a cross-user (``scope=all``)
    readout answers "which port / which user is misbehaving, how often".
    """
    rows = read_violations(scope=scope)
    by_kind: dict[str, int] = {}
    by_instance: dict[str, int] = {}
    by_user: dict[str, int] = {}
    for r in rows:
        by_kind[str(r.get("kind", "unknown"))] = by_kind.get(str(r.get("kind", "unknown")), 0) + 1
        by_instance[str(r.get("instance", "default"))] = by_instance.get(str(r.get("instance", "default")), 0) + 1
        by_user[str(r.get("user", "unknown"))] = by_user.get(str(r.get("user", "unknown")), 0) + 1
    first = rows[0].get("timestamp") if rows else None
    last = rows[-1].get("timestamp") if rows else None
    return {
        "total": len(rows),
        "by_kind": by_kind,
        "by_instance": by_instance,
        "by_user": by_user,
        "first": first,
        "last": last,
    }
