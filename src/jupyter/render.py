"""Render parsed agent output into Jupyter cell — unified output layer."""

from __future__ import annotations

import logging
import os
import re
import sys
from io import StringIO
from pathlib import Path

import base64

import pandas as pd
from IPython.display import Image, Markdown, display

from .namespace import Namespace, _describe
from .parser import ParsedResult

_log = logging.getLogger("jupyter.render")


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------


def render_text(text: str) -> None:
    """Print result content to the cell (agent output, data)."""
    if text:
        print(text)


def render_markdown(text: str) -> None:
    """Render markdown text in Jupyter cell output."""
    if text.strip():
        display(Markdown(text))


def render_info(text: str) -> None:
    """Print status / progress / hints to the cell."""
    if text:
        print(text)


def _is_debug() -> bool:
    """Check if debug mode is on (via %agent_config --debug)."""
    return logging.getLogger("jupyter").isEnabledFor(logging.DEBUG)


def render_debug(text: str) -> None:
    """Print to cell only when debug is on."""
    if _is_debug() and text:
        print(text)


def render_error(text: str) -> None:
    """Print to stderr in red."""
    if text:
        print(f"\033[91m{text}\033[0m", file=sys.stderr)


def render_code(ns: Namespace, code: str, auto: bool = False,
                cell_type: str = "code", replace_cell_id: str = "",
                on_cell_id: callable | None = None,
                run_below: bool = False, run_cell_ids: list | None = None) -> None:
    """Send code to frontend via comm; extension creates cell + optionally executes."""
    if not code:
        return
    code = code.strip()
    if cell_type != "markdown":
        code = _inline_hidden_scripts(code)
    if cell_type == "markdown":
        pass
    else:
        if _is_sql(code) and not code.startswith("%%sql"):
            code = f"%%sql\n{code}"
        code = f"{code}\n# %%agent generate code"

    _log.info("render_code: %d chars auto=%s type=%s", len(code), auto, cell_type)

    from .comm import send_cell_via_comm
    send_cell_via_comm(ns, code, auto=auto, cell_type=cell_type,
                       replace_cell_id=replace_cell_id, on_cell_id=on_cell_id,
                       run_below=run_below, run_cell_ids=run_cell_ids)


def render_variables(ns: Namespace) -> None:
    """Print available variables summary."""
    vars_dict = ns.vars()
    if vars_dict:
        print("Available variables:")
        for name, val in sorted(vars_dict.items()):
            print(f"  {_describe(name, val)}")


def render_image(data: bytes) -> None:
    """Display an inline image from raw bytes."""
    try:
        display(Image(data, format="png", embed=True))
    except Exception:
        pass


def render_sql_dataframe(ns: Namespace, data: dict, var_name: str):
    """Load SQL result into namespace as DataFrame. Returns the DataFrame or None."""
    sample = data.get("sample_data", [])
    df_sample = None
    if sample and len(sample) > 1:
        cols = sample[0]
        rows = sample[1:1001]  # max 1000 rows for preview display
        df_sample = pd.DataFrame(rows, columns=cols)
        render_text(f"[{var_name}] sample: {len(sample) - 1} rows x {len(cols)} cols" +
                    (" (showing first 1000)" if len(sample) > 1001 else ""))
        render_text(df_sample.to_string(max_rows=20, max_cols=10, max_colwidth=30))

    output_path = data.get("output_path", "")
    result_url = data.get("result_url", "")
    if output_path and Path(output_path).is_file():
        df = pd.read_csv(output_path)
        ns.inject(var_name, df)
        render_text(f"[{var_name}] loaded from {output_path}: {len(df)} rows x {len(df.columns)} cols")
        return df
    elif result_url:
        df = pd.read_csv(result_url)
        ns.inject(var_name, df)
        render_text(f"[{var_name}] loaded from {result_url}: {len(df)} rows x {len(df.columns)} cols")
        return df
    elif df_sample is not None:
        # Spark Connect returns rows inline (no persisted file) — use the sample.
        ns.inject(var_name, df_sample)
        return df_sample
    else:
        render_text(f"\033[91m[{var_name}] no data available\033[0m")
        return None


def render_output(ns: Namespace, result: ParsedResult,
                  skip_text: bool = False,
                  auto: bool = False, plan_cell_id: str = "",
                  on_cell_id: callable | None = None) -> None:
    """Dispatch parsed agent result to render methods."""
    if result.text and not skip_text:
        if result.is_markdown:
            render_markdown(result.text)
        else:
            render_text(result.text)

    if result.plan:
        content = "# %%plan\n\n" + result.plan
        def _on_plan_cell(cid):
            ns._shell.user_ns["__plan_cell_id__"] = cid
        render_code(ns, content, cell_type="markdown", replace_cell_id=plan_cell_id,
                    on_cell_id=_on_plan_cell)

    for name, content in result.csv.items():
        _load_csv(name, content, ns)

    for img_bytes in result.images:
        render_image(img_bytes)

    for path in result.files:
        p = Path(path)
        if path.endswith(".py"):
            if p.is_file():
                result.code_list.append(p.read_text())
        elif path.endswith(".csv"):
            _load_csv(path, "", ns)
        elif path.endswith((".png", ".jpg", ".jpeg", ".svg")):
            _display_image_file(path, "")
        elif p.is_file():
            ns.inject(path, p.read_text())
            render_text(f"[{path}] file loaded ({p.stat().st_size} bytes)")

    if result.code_list:
        from hook import HookRegistry, HookEvent
        context = {"code_list": result.code_list, "ns": ns}
        HookRegistry.dispatch(HookEvent.CODE_REVIEW, context)
        result.code_list = context["code_list"]

        for c in result.code_list:
            render_code(ns, c, auto=auto, on_cell_id=on_cell_id)


# ---------------------------------------------------------------------------
# internal helpers
# ---------------------------------------------------------------------------


# Matches the two shim shapes the agent uses to hide real code in a home-dir
# file and just load/run it from the cell:
#   exec(open('/Users/x/foo.py').read())
#   subprocess.run(["python3", "/Users/x/foo.py"], ...)  /  os.system("python3 /Users/x/foo.py")
_EXEC_OPEN_RE = re.compile(
    r"""exec\s*\(\s*open\s*\(\s*['"](?P<path>[^'"]+\.py)['"]\s*\)\s*\.\s*read\s*\(\s*\)\s*\)"""
)
_RUN_PY_RE = re.compile(
    r"""(?:subprocess\.\w+|os\.system|os\.popen)\s*\([^)]*?['"]?(?P<path>/[^'"\s,\]]+\.py)['"]?"""
)


def _expand_home(path: str) -> Path:
    return Path(os.path.expanduser(path)).resolve() if path else Path()


def _inline_hidden_scripts(code: str) -> str:
    """Hard guardrail: the agent must deliver code AS cells, not stash it in a
    standalone .py under the user's home dir and load it via a shim. When a cell
    is just ``exec(open('~/foo.py').read())`` or a subprocess/os.system runner
    pointing at such a file, splice the real file contents back into the cell and
    delete the hidden file — the kernel is the runtime, nothing runs off-notebook.

    Only home-dir files are inlined+removed; /tmp/ tool scratch is left alone.
    Non-shim code is returned untouched. Best-effort: any failure returns the
    original code so we never break a legitimate cell.
    """
    try:
        m = _EXEC_OPEN_RE.search(code) or _RUN_PY_RE.search(code)
        if not m:
            return code
        raw_path = m.group("path")
        shim = "exec_open" if _EXEC_OPEN_RE.search(code) else "subprocess_run"
        target = _expand_home(raw_path)
        # Only touch files under the user's home dir; leave /tmp/ scratch alone.
        try:
            home = Path.home().resolve()
            if home not in target.parents and target != home:
                return code
        except Exception:
            return code
        if not target.is_file():
            _log.warning("render_code: shim points at missing file %s; leaving cell as-is", raw_path)
            _record_guardrail_hit("hidden_script_missing", raw_path, shim=shim, inlined=False)
            return code
        body = target.read_text()
        _log.warning(
            "render_code: inlined hidden script %s (%d chars) into cell and removed the file "
            "(agent tried to run code off-notebook)", raw_path, len(body),
        )
        _record_guardrail_hit("hidden_script_inlined", raw_path, shim=shim,
                              inlined=True, body_chars=len(body))
        try:
            target.unlink()
        except Exception:
            pass
        header = f"# [skillbot] inlined from {raw_path} (agent must deliver code as cells, not a hidden .py)\n"
        return header + body.strip()
    except Exception:
        return code


def _record_guardrail_hit(kind: str, path: str, **fields) -> None:
    """Log a guardrail violation durably, and best-effort into session telemetry.

    Durable JSONL is the source of truth (survives crash / no live session);
    the session recorder mirror is best-effort so per-session views still show it.
    """
    try:
        from .guardrail_log import record_violation
        record_violation(kind, path=path, **fields)
    except Exception:
        _log.exception("guardrail durable log failed")
    try:
        from .telemetry import get_recorder
        rec = get_recorder()
        if rec:
            rec.record("guardrail_violation", kind=kind, path=path, **fields)
    except Exception:
        pass


def _is_sql(code: str) -> bool:
    """Use sqlparse to detect if *code* is SQL (not Python)."""
    if code.startswith("%%"):
        return False
    import sqlparse
    stmt = sqlparse.parse(code.strip())
    if not stmt:
        return False
    return stmt[0].get_type() not in (None, "UNKNOWN")


def _load_csv(name: str, content: str, ns: Namespace) -> None:
    """Try to load CSV from content (inline) or filesystem path."""
    for candidate in (content.strip(), name):
        for p in (Path(candidate), Path(candidate.strip("'\""))):
            try:
                if p.is_file():
                    df = pd.read_csv(str(p))
                    var_name = p.stem
                    ns.inject(var_name, df)
                    render_text(f"[{var_name}] {df.shape[0]} rows x {df.shape[1]} cols (from {p})")
                    return
            except Exception:
                pass

    if content.strip():
        try:
            df = pd.read_csv(StringIO(content))
            var_name = name.rsplit(".", 1)[0]
            ns.inject(var_name, df)
            render_text(f"[{var_name}] {df.shape[0]} rows x {df.shape[1]} cols")
        except Exception as e:
            ns.inject(name, content)
            render_text(f"[{name}] csv parse error: {e}")
    else:
        render_text(f"[{name}] csv load skipped (empty content, file not found)")


def _display_image_file(name: str, content: str) -> None:
    """Display an image file: disk path preferred, inline base64 fallback."""
    for candidate in (content.strip().strip("'\""), name):
        p = Path(candidate)
        if p.is_file():
            display(Image(filename=str(p)))
            render_text(f"[{name}] image displayed ({p.stat().st_size} bytes)")
            return

    if content.strip():
        try:
            display(Image(data=base64.b64decode(content.strip()), format="png", embed=True))
            render_text(f"[{name}] image displayed (inline base64)")
        except Exception:
            render_text(f"[{name}] image display error")
    else:
        render_text(f"[{name}] image display skipped (empty content, file not found)")


