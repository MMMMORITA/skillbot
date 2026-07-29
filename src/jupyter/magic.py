"""%%sql cell magic + agent panel integration — thin scheduling layer."""

import hashlib
import logging
import os as _os
import re
import shlex
import sys
import time
from enum import Enum, auto

from IPython.core.magic import Magics, cell_magic, line_magic, magics_class

from agent import AgentSession, SubAgentConfig
from agent.prompt import PromptBuilder
from chat import _AGENTS
from hook import HookGroup, HookRegistry, HookEvent
from jupyter.telemetry import get_recorder, SessionEventRecorder, set_recorder
from .config import pop_flag, parse_kv, configure_agent, load_yaml_config
from .namespace import Namespace
from .panel import send_to_panel, send_thinking
from .parser import parse
from .render import render_debug, render_error, render_info, render_output, render_sql_dataframe
from .dsl.sql import SqlRunner, sql_progress
from hook.impl.code_review import AgentCodeReviewHook

_log = logging.getLogger(__name__)

_INTERRUPT_NOTE = (
    "[System note: The user cancelled the previous request with Ctrl+C. "
    "Completely disregard the prior exchange — do NOT continue, reference, or respond to it. "
    "Respond ONLY to the current prompt below as if starting fresh.]"
)

SUB_AGENT_DEFAULTS = {
    "code_review": SubAgentConfig(
        name="code_review",
        description="Review code cells for logic consistency",
        tools=["Read", "Grep", "Glob"],
    ),
}


# ---------------------------------------------------------------------------
# jupyter-specific session helpers
# ---------------------------------------------------------------------------


# Set by frontend when notebook is activated — authoritative path for snapshot isolation
_active_notebook_path = ""


def _set_active_notebook_path(path: str) -> None:
    """Called by frontend to set the active notebook path for snapshot isolation."""
    global _active_notebook_path
    _active_notebook_path = path


def _notebook_path() -> str:
    """Return the notebook file path.

    Uses the frontend-provided path (most reliable), falls back to
    parent_header metadata, ip._notebook_path, then CWD.
    """
    global _active_notebook_path
    if _active_notebook_path:
        return _active_notebook_path
    try:
        ip = get_ipython()  # noqa: F821
        kernel = getattr(ip, "kernel", None)
        parent = getattr(kernel, "_parent_header", None) or {}
        nb = (parent.get("metadata") or {}).get("notebook_path")
        if nb:
            return nb
        nb = getattr(ip, "_notebook_path", None)
        if nb:
            return nb
    except Exception:
        pass
    return _os.path.realpath(_os.getcwd())


def _session_key() -> str:
    return hashlib.md5(_notebook_path().encode()).hexdigest()[:12]


def _get_magic():
    """Return the singleton AgentMagic instance, or None."""
    import sys as _sys
    mod = _sys.modules.get(__name__)
    return getattr(mod, "_agent_magic_instance", None)


def _panel_input(text: str, mode: str = "default") -> None:
    """Bridge: called by frontend requestExecute → dispatches to AgentMagic."""
    inst = _get_magic()
    if inst:
        inst._on_panel_input(text, mode)


def _panel_set_mode(mode: str) -> None:
    """Set mode without triggering agent execution."""
    inst = _get_magic()
    if inst:
        inst._handle_panel_mode(mode)


def _panel_track_cell_edit(source: str) -> None:
    """Record unexecuted cell edit in namespace."""
    inst = _get_magic()
    if inst:
        inst.ns.track_pending_edit(source)


def _panel_track_cell_delete(source: str) -> None:
    """Remove deleted cell from namespace context."""
    inst = _get_magic()
    if inst:
        inst.ns.remove_cell(source)


def _panel_save_conversation(nb_path: str, payload: str) -> None:
    """Bridge: persist a notebook's conversation buffer to disk."""
    from jupyter.conversation_store import save_conversation
    save_conversation(nb_path, payload)


def _panel_load_conversation(nb_path: str) -> None:
    """Bridge: load a persisted conversation buffer and push it to the panel.

    Emits a ``restore_conversation`` comm action the frontend listens for.
    """
    from jupyter.conversation_store import load_conversation
    from jupyter.panel import send_to_panel
    payload = load_conversation(nb_path)
    if payload:
        send_to_panel(None, "restore_conversation", path=nb_path, buffer=payload)


def _panel_list_conversations() -> None:
    """Bridge: push the list of persisted conversations to the panel switcher."""
    from jupyter.conversation_store import list_conversations
    from jupyter.panel import send_to_panel
    send_to_panel(None, "conversation_list", sessions=list_conversations())


def _panel_delete_conversation(nb_path: str) -> None:
    """Bridge: delete a notebook's persisted conversation from disk.

    Called when the user removes a session from the switcher, or when the
    underlying .ipynb file is deleted in the file browser.
    """
    from jupyter.conversation_store import delete_conversation
    delete_conversation(nb_path)


def _panel_switch_notebook(nb_path: str) -> None:
    """Bridge: the active notebook changed — give it its own agent conversation.

    The backend AgentMagic is a kernel-wide singleton with a single LLM session,
    so switching/opening a notebook must reset the agent's conversation memory,
    otherwise the new notebook inherits the previous one's history. Note this
    resets *LLM memory* only; the kernel's Python namespace is shared across all
    notebooks on the same kernel and cannot be per-notebook isolated.
    """
    inst = _get_magic()
    if inst:
        inst._handle_notebook_switch(nb_path)


def _panel_upload_skill(filename: str, b64: str) -> None:
    """Bridge: install a skill from a base64-encoded .zip uploaded by the panel.

    The frontend reads the user-chosen .zip via the browser FileReader, sends
    it as base64 (over the same requestExecute string channel used everywhere
    else), and we materialise it to a temp file before handing to
    ``SkillManager.install``. Refreshes the skill list on success.
    """
    inst = _get_magic()
    if inst:
        inst._handle_panel_upload_skill(filename, b64)


def _panel_restart_agent() -> None:
    """Bridge: restart the agent backend so skill enable/disable takes effect.

    hermes bakes the skill set into a per-session cached system prompt and
    never rebuilds mid-session, so a toggle only reaches the agent on a fresh
    session. This tears down the current session/client cleanly.
    """
    inst = _get_magic()
    if inst:
        inst._handle_panel_restart_agent()


def _merge_prompt(claude_md_path: str | None = None) -> str:
    return PromptBuilder.main(claude_md_path)


def _register_hooks(timeout: int, hook_cfg: dict) -> None:
    cfg = hook_cfg or {}
    groups = cfg.get("groups", {})
    cr_cfg = groups.get("code_review", {})
    cr_group = HookGroup("code_review", enabled=cr_cfg.get("enabled", True))
    cr_group.add(AgentCodeReviewHook())
    HookRegistry.register_group(cr_group, HookEvent.CODE_REVIEW)


class AgentState(Enum):
    """Explicit agent lifecycle state."""
    IDLE = auto()
    STREAMING = auto()           # agent is generating a response
    PLAN_REVIEW = auto()         # plan displayed, waiting for confirm/revision
    WAITING_CONFIRM = auto()     # response ready, waiting for user yes/no before acting
    AUTO_FIXING = auto()         # deferred auto-fix in progress (auto mode)


@magics_class
class AgentMagic(Magics):
    _agent = "claude-code"
    _timeout = 600
    _claude_md_path: str | None = None
    _tools_cfg: dict = {}

    def __init__(self, shell):
        super().__init__(shell)
        import sys as _sys
        _sys.modules[__name__]._agent_magic_instance = self
        self.ns = Namespace(shell)
        self._state = AgentState.IDLE
        self._busy = False                         # legacy — will be removed after refactor
        self._last_plan_prompt = ""
        self._last_plan_output = ""
        self._last_user_prompt = ""
        self._last_plan_result = None                  # cached ParsedResult for _implement_plan
        self._pending_result = None                    # ParsedResult waiting for user confirmation
        self._agent_cells: dict[str, str] = {}     # cell_id → code, for auto-fix lookup
        self._round_results: list[dict] = []        # [{cell_id, code, output}] for auto-fix lookup
        self._steps: list[dict] = []                # ordered step model: [{index,title,code,cell_id,status}]
        self._auto_pending = 0                      # count of auto-exec cells still running
        self._auto_fix_count = 0                    # limit retries per batch
        self._session_ready = False                 # lazy-init session on first query
        self._session_dirty = False                 # set on interrupt, prepend note on next query
        self._session_nb_path = None                # notebook path the current session is bound to
        self._jupyter_config_path = ""              # path from JUPYTER_CONFIG_PATH env var
        self._config_pending = None                 # pending (resolved, new_path, old_path)
        self._cell_restored = False                 # track if any cell was individually restored
        self._restoring_cells: set = set()          # cell_ids being restored, skip snapshot for these

        self._load_dotenv()

        # Load default config for hooks baseline, then auto-load from env var
        cfg = load_yaml_config("conf/jupyter_agent.yaml")
        self._hook_cfg = cfg.get("hooks", {})
        self._startup_config_msg = self._load_jupyter_config()
        self.ns.delta()
        shell.events.register("post_run_cell", self._on_cell_run)
        from .panel import init_panel_comm
        init_panel_comm(shell)

    # ---- state machine helpers -----------------------------------------------

    def _interrupt_cleanup(self, msg: str = "\n⏏ interrupted\n") -> None:
        """Unified KeyboardInterrupt handler — replaces 5 duplicated copies."""
        self._session_dirty = True
        self._state = AgentState.IDLE
        self._record_state("interrupt")
        self._busy = False
        self._auto_pending = 0
        self._auto_fix_count = 0
        self._pending_result = None
        self._round_results.clear()
        send_to_panel(self.ns, "text", content=msg)
        send_to_panel(self.ns, "result", summary="")
        send_to_panel(self.ns, "ready")

    def _stream_with_interrupt(self, prompt: str) -> tuple[str, bool]:
        """Stream agent response. Returns (raw_text, was_interrupted)."""
        if self._session_dirty:
            self._session_dirty = False
            prompt = _INTERRUPT_NOTE + "\n\n" + prompt
        rec = get_recorder()
        t0 = time.time()
        thinking_chars = 0
        tool_names: set[str] = set()

        def _on_chunk(t):
            send_to_panel(self.ns, "text", content=t)

        _think_buf = ""
        _think_last = 0.0

        def _on_thinking(t):
            nonlocal thinking_chars, _think_buf, _think_last
            thinking_chars += len(t)
            _think_buf += t
            now = time.time()
            if now - _think_last >= 0.2:
                send_thinking(_think_buf)
                _think_buf = ""
                _think_last = now

        try:
            def _on_tool_use(name):
                tool_names.add(name)

            raw = self._session.stream(prompt, show_text=False,
                on_chunk=_on_chunk,
                on_thinking=_on_thinking,
                on_tool_use=_on_tool_use)
            if _think_buf:
                send_thinking(_think_buf)
            send_to_panel(self.ns, "text", content="\n")
            elapsed_ms = int((time.time() - t0) * 1000)
            if rec:
                code_blocks = raw.count("```") // 2 if raw.strip() else 0
                rec.record("agent_response",
                    mode=getattr(self, '_last_mode', 'default'),
                    raw_text=raw.strip(),
                    code_blocks=code_blocks,
                    tool_names=sorted(tool_names),
                    thinking_chars=thinking_chars,
                    elapsed_ms=elapsed_ms,
                    interrupted=False,
                )
            return raw, False
        except KeyboardInterrupt:
            if _think_buf:
                send_thinking(_think_buf)
            elapsed_ms = int((time.time() - t0) * 1000)
            if rec:
                rec.record("agent_response",
                    elapsed_ms=elapsed_ms,
                    thinking_chars=thinking_chars,
                    tool_names=sorted(tool_names),
                    interrupted=True,
                )
            self._interrupt_cleanup()
            return "", True

    def _finish_agent_run(self, msg: str = "") -> None:
        """Clean up after agent run completes. Sends result + ready to frontend."""
        if self._state == AgentState.IDLE:
            return  # already finished, prevent duplicate ready/result
        self._state = AgentState.IDLE
        self._record_state("agent_done")
        self._busy = False
        self._auto_pending = 0
        self._pending_result = None
        self._round_results.clear()
        self._agent_cells.clear()
        if msg:
            send_to_panel(self.ns, "text", content=f"{msg}\n")
        send_to_panel(self.ns, "result", summary="")
        send_to_panel(self.ns, "ready")

    def _record_state(self, trigger: str) -> None:
        """Record workflow state transition for telemetry."""
        rec = get_recorder()
        if rec:
            rec.record("workflow_state",
                state=self._state.name,
                trigger=trigger,
            )

    def _track_agent_cell(self, cid: str, code_str: str) -> None:
        """Callback: track agent-generated cell IDs for batch completion detection.

        Also binds the real cell id to its step in the timeline model: each block
        rendered by ``render_output`` fires this once the frontend replies with the
        created cell's id, letting us map step ↔ cell and flip it to ``running``.
        """
        if not cid:
            return
        self._agent_cells[cid] = "pending"
        # Bind this cell to the first still-unbound step whose code matches, so a
        # step can be re-run / rolled back / revised individually later on.
        clean = self._strip_sentinel(code_str)
        for step in self._steps:
            if step.get("cell_id"):
                continue
            if step.get("code", "").strip() == clean:
                step["cell_id"] = cid
                step["status"] = "running"
                break
        else:
            # No code match (e.g. SQL rewrite) — bind by order to the next slot.
            for step in self._steps:
                if not step.get("cell_id"):
                    step["cell_id"] = cid
                    step["status"] = "running"
                    break
        self._push_steps()

    @staticmethod
    def _strip_sentinel(code_str: str) -> str:
        """Drop the ``# %%agent generate code`` marker render_code appends."""
        return code_str.replace("# %%agent generate code", "").strip()

    @staticmethod
    def _step_title(code: str) -> str:
        """Derive a short human label for a step from its code."""
        for line in code.splitlines():
            s = line.strip()
            if not s:
                continue
            # Prefer a leading comment as the intent, else the first real line.
            if s.startswith("#"):
                s = s.lstrip("#").strip()
            if s.startswith("%%sql"):
                s = "SQL query"
            return (s[:60] + "…") if len(s) > 60 else s
        return "step"

    def _build_steps(self, code_list: list[str]) -> None:
        """Seed the ordered step model for a fresh batch of agent cells."""
        self._steps = [
            {
                "index": i + 1,
                "title": self._step_title(c),
                "code": (c or "").strip(),
                "cell_id": "",
                "status": "pending",
            }
            for i, c in enumerate(code_list)
        ]
        self._push_steps()

    def _push_steps(self) -> None:
        """Send the current step timeline to the panel."""
        send_to_panel(self.ns, "step_timeline", steps=self._steps)

    def _mark_step(self, cell_id: str, status: str, code: str = "") -> None:
        """Flip the step bound to ``cell_id`` (refreshing its code) and push."""
        if not cell_id:
            return
        for step in self._steps:
            if step.get("cell_id") == cell_id:
                step["status"] = status
                if code:
                    step["code"] = self._strip_sentinel(code)
                    step["title"] = self._step_title(step["code"])
                self._push_steps()
                return


    def _handle_violations(self, arg: str) -> None:
        """`/violations` — read back the durable guardrail-violation log.

        Pure backend (like `/steps`): reads `.run/guardrail/<instance>.jsonl`
        and renders a markdown summary + recent rows to the panel, so the
        model's misbehaviour rate is directly queryable in the UI.

        Args:
          (none)          this instance/port only
          ``all``         merge every instance file → cross-user/port view
          ``clear``       delete this instance's log
          ``clear all``   delete every instance's log
        """
        from . import guardrail_log
        arg = (arg or "").strip()

        if arg.startswith("clear"):
            wipe_all = arg.split()[1:2] == ["all"]
            try:
                targets = (guardrail_log._all_paths() if wipe_all
                           else [guardrail_log._default_path()])
                removed = 0
                for p in targets:
                    if p.is_file():
                        p.unlink()
                        removed += 1
                scope_txt = "all instances" if wipe_all else "this instance"
                send_to_panel(self.ns, "text",
                    content=f"✓ Guardrail violation log cleared ({scope_txt}, "
                            f"{removed} file(s)).\n")
            except OSError as exc:
                send_to_panel(self.ns, "text", content=f"✗ Could not clear log: {exc}\n")
            return

        scope = "all" if arg == "all" else "instance"
        summary = guardrail_log.summarize(scope=scope)
        total = summary.get("total", 0)
        scope_label = "across all instances" if scope == "all" else "this instance"
        if not total:
            hint = "" if scope == "all" else " — try `/violations all` for a cross-instance view"
            send_to_panel(self.ns, "text",
                content=f"✓ No guardrail violations recorded ({scope_label}) — the agent "
                        f"has been delivering code as cells.{hint}\n")
            return

        lines = [f"### 🛡️ Guardrail violations: {total} total ({scope_label})"]
        by_kind = summary.get("by_kind", {})
        if by_kind:
            lines.append("")
            for kind, n in sorted(by_kind.items(), key=lambda kv: -kv[1]):
                lines.append(f"- **{kind}**: {n}")

        # Per-instance / per-user breakdown is the whole point of `all`.
        if scope == "all":
            by_inst = summary.get("by_instance", {})
            by_user = summary.get("by_user", {})
            if by_inst:
                lines.append("")
                lines.append("**By instance:** "
                    + " · ".join(f"`{k}`={n}" for k, n in sorted(by_inst.items(), key=lambda kv: -kv[1])))
            if by_user:
                lines.append("**By user:** "
                    + " · ".join(f"`{k}`={n}" for k, n in sorted(by_user.items(), key=lambda kv: -kv[1])))

        if summary.get("first") and summary.get("last"):
            lines.append("")
            lines.append(f"_First: {summary['first']} · Last: {summary['last']}_")

        recent = guardrail_log.read_violations(limit=10, scope=scope)
        if recent:
            lines.append("")
            lines.append("**Most recent (up to 10):**")
            lines.append("")
            lines.append("| time | instance | user | kind | path |")
            lines.append("|------|----------|------|------|------|")
            for r in reversed(recent):
                ts = str(r.get("timestamp", ""))[:19]
                lines.append(
                    f"| {ts} | {r.get('instance', '')} | {r.get('user', '')} "
                    f"| {r.get('kind', '')} | `{r.get('path', '')}` |"
                )
        lines.append("")
        lines.append("_`/violations all` for every instance · `/violations clear [all]` to reset._")
        send_to_panel(self.ns, "text", content="\n".join(lines) + "\n")

    def _ask_confirm(self, msg: str, pending_result=None) -> None:
        """Show Yes/No confirmation — text + buttons via comm."""
        self._state = AgentState.WAITING_CONFIRM
        self._record_state("confirm_shown")
        self._busy = False
        self._pending_result = pending_result
        send_to_panel(self.ns, "result", summary="")
        send_to_panel(self.ns, "ready")
        send_to_panel(self.ns, "text",
            content=f"\n{'─'*40}\n{msg}\nType /continue yes or /continue no\n{'─'*40}\n")
        send_to_panel(self.ns, "continue_confirm", summary=msg)

    def _resolve_no_code(self, result) -> None:
        """Fallback when the agent returned neither code nor a gate.

        Old behavior blindly showed a blank "Continue?" Yes/No even when the
        model was actually asking the human a question — so the buttons looked
        meaningless. Now: if the prose contains a question, echo the model's
        actual question as the confirm prompt so Yes/No is at least intelligible;
        otherwise fall back to the generic "Continue?".
        """
        text = (getattr(result, "text", "") or "").strip()
        has_question = ("?" in text) or ("？" in text)

        if has_question and text:
            self._ask_confirm(text, pending_result=result)
        else:
            self._ask_confirm("Continue?", pending_result=result)

    # Prose that signals the model needs the human to TYPE an input (a path, a
    # column, a value) before its code can run. Conservative — must co-occur
    # with a question mark so plain statements never trip it.
    _INPUT_REQUEST_PATTERNS = (
        re.compile(r"路径|地址|目录|文件在(?:哪|什么)|在(?:哪里|什么地方)|哪个文件|哪些文件"),
        re.compile(r"叫什么|什么名字|列名|字段名|表名"),
        re.compile(r"告诉我|发(?:我|给我)|提供|贴(?:一下|上)"),
        re.compile(r"what(?:'s| is) the (?:path|file|column|name|value)|"
                   r"which file|where (?:is|are)|provide the", re.I),
    )

    def _asks_for_input(self, text: str) -> bool:
        """True when the model is asking the human to TYPE something needed to
        run the code (a path, column, value) — so a Yes/No execute prompt makes
        no sense yet."""
        if not text or ("?" not in text and "？" not in text):
            return False
        return any(p.search(text) for p in self._INPUT_REQUEST_PATTERNS)

    def _confirm_code_or_ask(self, result) -> None:
        """Default-mode landing when the agent returned runnable code.

        Guards the mismatch the user hit: the model both generated cells AND
        asked for an input those cells depend on (e.g. a file path). Executing
        them would just fail, so instead of a nonsensical "Generate and execute
        N cells?" Yes/No, we surface the question and return control to the
        input box — the human types the answer and the code is regenerated next
        turn. When the code is actually runnable, the normal confirm shows.
        """
        text = (getattr(result, "text", "") or "").strip()
        if self._asks_for_input(text):
            self._record_state("await_user_input")
            self._finish_agent_run()
            return
        self._ask_confirm(f"Generate and execute {len(result.code_list)} cells?",
                          pending_result=result)

    def _reply_to_agent(self, text: str, kind: str = "continue") -> None:
        """Feed a free-text human reply back into the live session.

        Powers the "type your answer" box on the confirm overlays: instead
        of a bare Yes/No, the human can answer the agent's question (a file path,
        a clarification) in prose. We drop any pending code (it was blocked on
        this very answer), echo the reply, and stream the continuation in the
        SAME session so the agent still remembers what it asked.
        """
        text = text.strip()
        if not text:
            send_to_panel(self.ns, "ready")
            return
        self._pending_result = None
        send_to_panel(self.ns, "text", content=f"↳ {text}\n")
        self._state = AgentState.STREAMING
        self._record_state(f"{kind}_reply")
        self._busy = True
        rec = get_recorder()
        if rec:
            rec.record("agent_prompt", mode=f"{kind}_reply", prompt="", context_preview="")
        prompt = (
            "[System: The human replied to your previous question in prose "
            "(they typed an answer rather than picking an option). Their reply "
            "follows — continue the task using it.]\n\n" + text
        )
        raw, interrupted = self._stream_with_interrupt(prompt)
        if interrupted:
            return
        if not raw.strip():
            self._finish_agent_run()
            return
        result = parse(raw)
        if result.code_list:
            self._confirm_code_or_ask(result)
        else:
            self._resolve_no_code(result)

    def _handle_continue(self, arg: str) -> None:
        """Handle /continue yes|no|<free text> from panel.

        yes  -> run the pending cells; no -> stop. Anything else is the human
        TYPING an answer instead of picking Yes/No (e.g. supplying a file path
        the agent asked for): we drop the pending code and feed the reply back
        into the live session so the agent continues with that answer in
        context.
        """
        arg = arg.strip()
        rec = get_recorder()
        if arg and arg not in ("yes", "no"):
            self._reply_to_agent(arg, kind="continue")
            return
        if rec:
            rec.record("agent_continue", choice="yes" if arg == "yes" else "no")
        if arg != "yes":
            self._finish_agent_run("Task stopped")
            self._record_state("user_stop")
            return

        pending = self._pending_result
        self._pending_result = None
        if pending is not None and pending.code_list:
            # Has code cells: inject + auto-execute
            self._state = AgentState.STREAMING
            self._record_state("user_continue")
            self._busy = True
            self._agent_cells.clear()
            self._auto_fix_count = 0
            self._auto_pending = len(pending.code_list)
            self._build_steps(pending.code_list)
            render_output(self.ns, pending, auto=True, on_cell_id=self._track_agent_cell)
            if self._auto_pending == 0:
                self._finish_agent_run()
            # else: _on_cell_run handles completion → finish
            return

        # No code cells: continue the conversation
        prompt = "[System: Continue with the task. Generate the next steps.]"
        self._state = AgentState.STREAMING
        self._record_state("user_continue")
        self._busy = True
        if rec:
            rec.record("agent_prompt", mode="continue", prompt="", context_preview="")
        raw, interrupted = self._stream_with_interrupt(prompt)
        if interrupted:
            return
        if not raw.strip():
            self._finish_agent_run()
            return
        result = parse(raw)
        if result.code_list:
            self._confirm_code_or_ask(result)
        else:
            self._resolve_no_code(result)

    def _handle_panel_stop(self) -> None:
        """Handle /stop — exit current task immediately."""
        if self._state == AgentState.IDLE:
            send_to_panel(self.ns, "text", content="No active task.\n")
            return
        try:
            self._session.interrupt()
        except Exception:
            pass
        self._finish_agent_run("Task stopped")

    @staticmethod
    def _load_dotenv() -> None:
        """Load conf/.env into os.environ (only vars not already set)."""
        from pathlib import Path
        # Use absolute path — kernel cwd may not be project root
        env_file = Path(__file__).resolve().parents[2] / "conf" / ".env"
        if not env_file.is_file():
            return
        try:
            with open(env_file) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, val = line.partition("=")
                    key = key.strip()
                    val = val.strip().strip('"').strip("'")
                    if key and key not in _os.environ:
                        _os.environ[key] = val
        except Exception:
            print(f"[agent_config] failed to read {env_file}", file=sys.stderr)

    def _load_jupyter_config(self) -> str:
        """Load config from JUPYTER_CONFIG_PATH env var and apply it.
        Returns status message (includes tool discovery output)."""
        from io import StringIO
        from pathlib import Path
        config_path = _os.environ.get("JUPYTER_CONFIG_PATH", "")
        if not config_path:
            return "[agent_config] JUPYTER_CONFIG_PATH not set, no config loaded\n"
        if not Path(config_path).is_file():
            return f"[agent_config] config file not found: {config_path}\n"
        self._jupyter_config_path = config_path

        # Capture stdout during configure_agent (tool discovery prints here)
        capture = StringIO()
        old_stdout = sys.stdout
        sys.stdout = capture
        try:
            resolved = configure_agent(
                config_path=config_path,
                cli_agent=None, cli_timeout=None,
                cli_claude_md=None, cli_debug=None,
                cli_env={},
                enable_hooks=[], disable_hooks=[],
                defaults={},
                current_agent=self._agent,
                current_timeout=self._timeout,
                current_claude_md=self._claude_md_path,
                current_hook_cfg=self._hook_cfg,
            )
        finally:
            sys.stdout = old_stdout

        tool_output = capture.getvalue().strip()
        if resolved:
            self._apply_config(resolved)
            lines = [f"[agent_config] loaded: {config_path}  agent={self._agent} timeout={self._timeout}s"]
            if tool_output:
                lines.append(tool_output)
            return "\n".join(lines) + "\n"
        else:
            return f"[agent_config] failed to load: {config_path}\n"

    def _ensure_session(self) -> None:
        """Lazy-init agent session on first query (keeps kernel startup fast)."""
        if self._session_ready:
            return
        # Drop stale client from interrupted session (avoid lingering TCP connections)
        old = getattr(self, '_session', None)
        if old is not None:
            old.cleanup()
        self._init_session(self._agent, self._timeout, self._claude_md_path)
        if self._session.client is None:
            raise RuntimeError(f"session init failed — is agent {self._agent} running?")
        from pathlib import Path as _Path
        _project_root = _Path(__file__).resolve().parents[2]
        rec = SessionEventRecorder(
            session_id=self._session.session_id,
            path=str(_project_root / ".run" / "sessions" / f"{self._session.session_id}.jsonl"),
        )
        set_recorder(rec)
        # Register atexit flush so session data is written on kernel shutdown
        rec_ref = rec
        import atexit as _atexit
        @_atexit.register
        def _flush_telemetry():
            rec_ref.flush()
        self._session_ready = True

    def _init_session(self, agent: str, timeout: int, claude_md: str | None = None) -> None:
        self._session = AgentSession(agent, timeout)
        self._session.configure_subs(SUB_AGENT_DEFAULTS)
        self._session.init_session(
            system_prompt=_merge_prompt(claude_md),
            session_key=_session_key(),
            on_init=lambda s: _register_hooks(timeout, self._hook_cfg),
        )

    def _on_cell_run(self, result):
        info = getattr(result, "info", None)
        if info is None:
            return
        # Skip executions that aren't real notebook cells (frontend queries, etc.)
        if not getattr(info, "store_history", True):
            return
        code = getattr(info, "raw_cell", "")
        if not code:
            return

        is_agent_cell = "# %%agent generate code" in code
        cell_id = getattr(info, "cell_id", "")
        output = str(info.result) if getattr(info, "result", None) else ""

        # Track cell in namespace (do this before any early return — bug 10 fix)
        error_str = ""
        if not result.success:
            e = result.error_in_exec or result.error_before_exec
            if e:
                error_str = str(e)[:2000]
        self.ns.track_cell(code.strip(), output.strip(), cell_id=cell_id)

        # ---- agent cell tracking ----
        if is_agent_cell:
            # Track cell for auto-fix lookup
            self._agent_cells[cell_id] = code.strip()
            self._round_results.append({
                "cell_id": cell_id, "code": code.strip(), "output": output.strip()
            })

            # Flip the matching step to done/failed so the timeline reflects reality
            # (covers both the initial batch and any single-step re-run from the panel).
            self._mark_step(cell_id, "failed" if not result.success else "done", code=code.strip())

            # Auto mode: decrement pending count
            if self._auto_pending > 0:
                self._auto_pending -= 1
                _log.debug("auto pending: %d remaining", self._auto_pending)

            # Auto-fix: agent-generated cell failed → ask AI to fix
            if not result.success and self._state in (AgentState.STREAMING, AgentState.AUTO_FIXING):
                if error_str:
                    self._auto_fix_cell(code.strip(), error_str)

        # ---- snapshot logic ----
        restoring = cell_id in getattr(self, '_restoring_cells', set())
        if cell_id and code.strip() and not restoring:
            from .cell_snapshot import save as save_cell_snapshot
            save_cell_snapshot(cell_id, code.strip(), output.strip(), error_str, nb_path=_notebook_path())
        if code.strip():
            if restoring:
                self._restoring_cells.discard(cell_id)
            else:
                from .notebook_snapshot import take as take_snapshot
                take_snapshot(self.ns._cells, nb_path=_notebook_path())

        # ---- telemetry ----
        rec = get_recorder()
        if rec:
            cell_type = "plain"
            if code.startswith("%%sql"):
                cell_type = "%%sql"
            error = getattr(result, "error_in_exec", None) or getattr(result, "error_before_exec", None)
            rec.record("cell_executed",
                cell_id=cell_id,
                type=cell_type,
                code=code.strip(),
                output=output.strip(),
                error=str(error) if error else None,
                elapsed_ms=0.0,
                is_agent_cell=is_agent_cell,
                exec_order=rec.next_exec_order(),
            )

        # ---- state transitions ----
        # Auto mode / confirmed execution: all cells complete → finish or continue
        if is_agent_cell and self._auto_pending == 0 and self._state in (AgentState.STREAMING, AgentState.AUTO_FIXING):
            self._finish_agent_run()

    # ---- panel handler ----

    def _on_panel_input(self, text: str, mode: str = "default") -> None:
        """Handle input from right-side panel."""
        # Flush startup config message on first interaction
        msg = getattr(self, '_startup_config_msg', '')
        if msg and send_to_panel(self.ns, "text", content=msg):
            self._startup_config_msg = ""
        text = text.strip()
        if text.startswith("/confirm "):
            self._handle_panel_confirm(text[9:])
        elif text == "/clear":
            self._handle_panel_clear()
        elif text.startswith("/mode "):
            self._handle_panel_mode(text[6:].strip())
        elif text.startswith("/skills"):
            self._handle_panel_skills(text)
        elif text.startswith("/config"):
            self._handle_panel_config(text)
        elif text == "/snapshot":
            from .notebook_snapshot import take as take_snapshot
            path = take_snapshot(self.ns._cells, nb_path=_notebook_path())
            if path:
                send_to_panel(self.ns, "text", content=f"✓ Snapshot saved: {path.stem}\n")
            else:
                send_to_panel(self.ns, "text", content="✗ No cells to snapshot.\n")
        elif text.startswith("/continue"):
            self._handle_continue(text[10:].strip())
        elif text == "/stop":
            self._handle_panel_stop()
        elif text.startswith("/cell-optimize"):
            self._handle_cell_optimize(text)
        elif text == "/steps":
            self._push_steps()
        elif text.startswith("/violations"):
            self._handle_violations(text[len("/violations"):].strip())
        elif text.startswith("/cell-snapshot-restore"):
            self._handle_cell_restore(text)
        else:
            self._handle_panel_prompt(text, mode)

    def _handle_panel_prompt(self, prompt: str, mode: str = "default") -> None:
        """Execute agent prompt from panel: stream to panel + inject cells to left."""
        # Session init
        try:
            self._ensure_session()
        except KeyboardInterrupt:
            self._interrupt_cleanup()
            return
        except Exception:
            _log.exception("_handle_panel_prompt: session init failed")
            send_to_panel(self.ns, "text", content="✗ session initialization failed, check server logs\n")
            send_to_panel(self.ns, "result", summary="")
            return

        if self._state != AgentState.IDLE:
            send_to_panel(self.ns, "text", content="⏳ agent is working, please wait...\n")
            send_to_panel(self.ns, "result", summary="")
            return

        # Build prompt with context
        self._last_user_prompt = prompt
        ctx = self.ns.delta()
        full = f"{ctx}\n\n{prompt}" if ctx else prompt

        if mode == "plan":
            self._last_plan_prompt = prompt
            plan_prefix = (
                "[System: You are in plan mode. Explore the request, research the codebase, "
                "and design an implementation approach. Present your plan as structured markdown. "
                "Do NOT write or execute any code until the user confirms the plan.]\n\n"
            )
            full = plan_prefix + full

        # Stream
        self._state = AgentState.STREAMING
        self._busy = True
        rec = get_recorder()
        if rec:
            rec.record("agent_prompt",
                mode=mode,
                prompt=prompt,
                context_preview=ctx[:500] if ctx else "",
            )
        raw, interrupted = self._stream_with_interrupt(full)
        if interrupted:
            return
        if not raw.strip():
            self._finish_agent_run()
            return

        # Process result
        result = parse(raw)
        if mode == "plan":
            self._last_plan_output = raw.strip()
            self._last_plan_result = result  # cache parsed result to avoid re-parse in _implement_plan
            plan_text = result.plan or result.text or ""
            send_to_panel(self.ns, "plan_confirm", summary=plan_text)
            self._state = AgentState.PLAN_REVIEW
            self._busy = False
            send_to_panel(self.ns, "ready")
        elif mode == "auto":
            _log.info("auto mode: %d code blocks", len(result.code_list))
            self._agent_cells.clear()
            self._auto_fix_count = 0
            self._auto_pending = len(result.code_list)
            if self._auto_pending == 0:
                self._finish_agent_run()
            else:
                self._build_steps(result.code_list)
                render_output(self.ns, result, auto=True, on_cell_id=self._track_agent_cell)
                # _on_cell_run handles completion: sends ready when _auto_pending == 0
        else:
            if result.code_list:
                self._confirm_code_or_ask(result)
            else:
                self._resolve_no_code(result)

    def _handle_panel_mode(self, mode: str) -> None:
        """Handle /mode from panel — mode is tracked by frontend, nothing to persist."""

    def _skill_mgr(self):
        """Return the live SkillManager, or a fresh one for the configured agent.

        Used by upload/skills handlers so the manager always points at the same
        directory the agent loads from, whether or not a session exists yet.
        """
        session = getattr(self, '_session', None)
        if session and session.client:
            return session.client.skills
        try:
            from chat.skill import SkillManager
            from chat import _resolve_skill_dir
            return SkillManager(_resolve_skill_dir(self._agent))
        except Exception as e:
            _log.warning("_skill_mgr: fallback SkillManager failed: %s", e)
            return None

    def _refresh_skill_list(self, mgr) -> None:
        """Re-scan and push the current skill list to the panel."""
        from .panel import send_skill_list
        send_skill_list([
            {"name": s.name, "description": s.description, "enabled": s.enabled,
             "category": s.category, "body": s.body[:1000]}
            for s in mgr.list_skills()
        ])

    def _handle_panel_upload_skill(self, filename: str, b64: str) -> None:
        """Install an uploaded (base64) .zip skill, then refresh the list."""
        import base64
        import tempfile
        import os
        from .panel import send_to_panel
        mgr = self._skill_mgr()
        if not mgr:
            send_to_panel(self.ns, "text", content="✗ session not initialized\n")
            return
        name = os.path.basename(filename or "skill.zip")
        if not name.lower().endswith(".zip"):
            send_to_panel(self.ns, "text", content=f"✗ expected a .zip file, got: {name}\n")
            return
        tmp_path = None
        try:
            raw = base64.b64decode(b64)
            fd, tmp_path = tempfile.mkstemp(prefix="skillbot-upload-", suffix=".zip")
            with os.fdopen(fd, "wb") as fh:
                fh.write(raw)
            info = mgr.install(tmp_path)
            send_to_panel(self.ns, "text", content=f"✓ {info.name} uploaded (enabled)\n")
            self._refresh_skill_list(mgr)
        except Exception as e:
            send_to_panel(self.ns, "text", content=f"✗ upload failed: {e}\n")
        finally:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

    def _reset_session_state(self) -> None:
        """Tear down the LLM session and wipe all per-conversation state.

        Shared by /clear and notebook switching. Drops the agent session (so the
        next prompt rebuilds a fresh one with a new session_id → empty LLM
        context) and resets the step model, round results, cell map, and any
        pending confirm/gate/plan state. Does NOT touch the kernel's Python
        namespace — variables persist (kernel-wide, can't be per-notebook).
        """
        old = getattr(self, '_session', None)
        if old is not None:
            try:
                old.cleanup()
            except Exception as e:
                _log.warning("session cleanup failed: %s", e)
        self._session = None
        self._session_ready = False
        self._session_dirty = False
        self._state = AgentState.IDLE
        self._busy = False
        self._steps = []
        self._round_results = []
        self._agent_cells = {}
        self._auto_pending = 0
        self._auto_fix_count = 0
        self._last_plan_prompt = ""
        self._last_plan_output = ""
        self._last_plan_result = None
        self._last_user_prompt = ""
        self._pending_result = None

    def _handle_panel_clear(self) -> None:
        """Handle /clear — wipe the visible panel AND the agent's memory.

        Previously /clear only blanked the frontend display; the LLM session kept
        its full history, so the agent still 'remembered' everything. Now it truly
        starts a new conversation (fresh session on the next prompt).
        """
        from .panel import send_to_panel
        self._reset_session_state()
        send_to_panel(self.ns, "clear")
        self._push_steps()  # push the now-empty step timeline
        send_to_panel(self.ns, "ready")

    def _handle_notebook_switch(self, nb_path: str) -> None:
        """Active notebook changed — start a fresh agent conversation for it.

        Resets LLM memory + step model so the new notebook doesn't inherit the
        previous one's history. Kernel variables are shared and stay put.

        Guards against spurious ``currentChanged`` events (tab focus, layout
        restore) by only resetting when the notebook path actually differs from
        the one the current session is bound to, and never mid-task.
        """
        from .panel import send_to_panel
        prev = getattr(self, "_session_nb_path", None)
        if prev == nb_path:
            return  # same notebook — nothing to do
        self._session_nb_path = nb_path
        # First bind, or session never started → nothing to reset yet.
        if prev is None or (not self._session_ready and self._session is None):
            self._steps = []
            self._push_steps()
            return
        # Don't yank the rug out from under a running task.
        if self._state != AgentState.IDLE:
            _log.info("notebook switch ignored — agent busy (state=%s)", self._state)
            self._session_nb_path = prev  # keep binding until the task finishes
            return
        _log.info("notebook switch → resetting agent conversation (path=%s)", nb_path)
        self._reset_session_state()
        self._push_steps()
        send_to_panel(
            self.ns, "text",
            content="⟳ new notebook — fresh agent conversation "
                    "(kernel variables are shared across notebooks)\n",
        )

    def _handle_panel_restart_agent(self) -> None:
        """Tear down the current session so the next prompt rebuilds it fresh.

        A fresh session re-reads config.yaml (skill enable/disable) and starts a
        new hermes session with no previously-injected skill bodies — the only
        way a toggle deterministically reaches the running agent.
        """
        from .panel import send_to_panel
        self._reset_session_state()
        send_to_panel(self.ns, "text",
                      content="⟳ agent restarted — skill changes apply on your next message\n")
        send_to_panel(self.ns, "ready")

    def _handle_panel_skills(self, text: str) -> None:
        """Handle /skills commands from panel."""
        parts = text.split()
        if len(parts) < 2:
            cmd = "list"  # /skills alone defaults to list
        else:
            cmd = parts[1]
        session = getattr(self, '_session', None)
        mgr = None
        if session and session.client:
            mgr = session.client.skills
        else:
            # Session not yet initialized (e.g. user opens Skills before sending a
            # prompt) — build a SkillManager for the *configured* agent, not a
            # hard-coded default, so the list matches what the agent will load.
            try:
                from chat.skill import SkillManager
                from chat import _resolve_skill_dir
                mgr = SkillManager(_resolve_skill_dir(self._agent))
            except Exception as e:
                _log.warning("_handle_panel_skills: fallback SkillManager failed: %s", e)

        if cmd == "list":
            if not mgr:
                send_to_panel(self.ns, "text", content="✗ session not initialized\n")
                return
            skills = mgr.list_skills()
            from .panel import send_skill_list
            if not skills:
                send_skill_list([])  # show empty state in panel
                return
            send_skill_list([
                {"name": s.name, "description": s.description, "enabled": s.enabled,
                 "category": s.category, "body": s.body[:1000]}
                for s in skills
            ])

        elif cmd == "info":
            name = parts[2] if len(parts) > 2 else ""
            if not name:
                send_to_panel(self.ns, "text", content="Usage: /skills info <name>\n")
                return
            if not mgr:
                send_to_panel(self.ns, "text", content="✗ session not initialized\n")
                return
            s = mgr.get_skill(name)
            if not s:
                send_to_panel(self.ns, "text", content=f"✗ skill not found: {name}\n")
                return
            from .panel import send_skill_info
            send_skill_info({
                "name": s.name,
                "description": s.description,
                "enabled": s.enabled,
                "body": s.body[:2000],
                "path": s.path,
            })

        elif cmd == "enable":
            name = parts[2] if len(parts) > 2 else ""
            if not name:
                send_to_panel(self.ns, "text", content="Usage: /skills enable <name>\n")
                return
            if not mgr:
                send_to_panel(self.ns, "text", content="✗ session not initialized\n")
                return
            try:
                mgr.enable(name)
                send_to_panel(self.ns, "text",
                              content=f"✓ {name} enabled — restart agent server to apply\n")
            except FileNotFoundError:
                send_to_panel(self.ns, "text", content=f"✗ skill not found: {name}\n")

        elif cmd == "disable":
            name = parts[2] if len(parts) > 2 else ""
            if not name:
                send_to_panel(self.ns, "text", content="Usage: /skills disable <name>\n")
                return
            if not mgr:
                send_to_panel(self.ns, "text", content="✗ session not initialized\n")
                return
            try:
                mgr.disable(name)
                send_to_panel(self.ns, "text",
                              content=f"✓ {name} disabled — restart agent server to apply\n")
            except FileNotFoundError:
                send_to_panel(self.ns, "text", content=f"✗ skill not found: {name}\n")

        elif cmd == "toggle":
            name = parts[2] if len(parts) > 2 else ""
            if not name:
                send_to_panel(self.ns, "text", content="Usage: /skills toggle <name>\n")
                return
            if not mgr:
                send_to_panel(self.ns, "text", content="✗ session not initialized\n")
                return
            try:
                s = mgr.get_skill(name)
                if not s:
                    send_to_panel(self.ns, "text", content=f"✗ skill not found: {name}\n")
                    return
                if s.enabled:
                    mgr.disable(name)
                else:
                    mgr.enable(name)
                # Send updated skill list (text toggle confirmation is redundant with list UI)
                self._refresh_skill_list(mgr)
            except FileNotFoundError:
                send_to_panel(self.ns, "text", content=f"✗ skill not found: {name}\n")

        elif cmd == "install":
            path = parts[2] if len(parts) > 2 else ""
            if not path:
                send_to_panel(self.ns, "text", content="Usage: /skills install <path/to/skill.zip>\n")
                return
            if not mgr:
                send_to_panel(self.ns, "text", content="✗ session not initialized\n")
                return
            from pathlib import Path
            zpath = Path(path)
            if not zpath.is_absolute():
                import os
                zpath = Path(os.getcwd()) / zpath
            try:
                info = mgr.install(str(zpath))
                send_to_panel(self.ns, "text",
                              content=f"✓ {info.name} installed (enabled)\n")
                # Refresh skill list
                self._refresh_skill_list(mgr)
            except FileNotFoundError:
                send_to_panel(self.ns, "text", content=f"✗ file not found: {path}\n")
            except ValueError as e:
                send_to_panel(self.ns, "text", content=f"✗ {e}\n")

        elif cmd == "uninstall":
            name = parts[2] if len(parts) > 2 else ""
            if not name:
                send_to_panel(self.ns, "text", content="Usage: /skills uninstall <name>\n")
                return
            if not mgr:
                send_to_panel(self.ns, "text", content="✗ session not initialized\n")
                return
            try:
                mgr.uninstall(name)
                send_to_panel(self.ns, "text", content=f"✓ {name} uninstalled\n")
                # Refresh skill list
                self._refresh_skill_list(mgr)
            except FileNotFoundError:
                send_to_panel(self.ns, "text", content=f"✗ skill not found: {name}\n")

        else:
            send_to_panel(self.ns, "text",
                          content=f"Unknown command: /skills {cmd}\n"
                                  "Usage: /skills list|info|enable|disable|install|uninstall\n")

    def _handle_panel_config(self, text: str) -> None:
        """Handle /config commands from panel."""
        parts = text.split(maxsplit=1)
        path = parts[1].strip() if len(parts) > 1 else ""

        # Confirmation: /config --yes or /config --no
        if path == "--yes":
            pending = getattr(self, '_config_pending', None)
            if pending:
                resolved, new_path, _old_path = pending
                _os.environ["JUPYTER_CONFIG_PATH"] = new_path
                self._jupyter_config_path = new_path
                summary = self._apply_config(resolved)
                send_to_panel(self.ns, "text", content=(
                    f"\n{'─'*50}\n✓ Config applied\n"
                    f"  path    : {new_path}\n"
                    f"  agent   : {self._agent}\n"
                    f"  timeout : {self._timeout}s\n"
                    f"  changes : {summary}\n"
                    f"{'─'*50}\n"))
                self._config_pending = None
            else:
                send_to_panel(self.ns, "text", content="No pending config change.\n")
            return
        if path == "--no":
            pending = getattr(self, '_config_pending', None)
            if pending:
                _resolved, _new_path, old_path = pending
                self._jupyter_config_path = old_path
                send_to_panel(self.ns, "text", content="✗ Config change cancelled.\n")
                self._config_pending = None
            else:
                send_to_panel(self.ns, "text", content="No pending config change.\n")
            return

        if path:
            from pathlib import Path
            if not Path(path).is_file():
                send_to_panel(self.ns, "text", content=f"✗ File not found: {path}\n")
                return

            resolved = configure_agent(
                config_path=path,
                cli_agent=None, cli_timeout=None,
                cli_claude_md=None, cli_debug=None,
                cli_env={},
                enable_hooks=[], disable_hooks=[],
                defaults={},
                current_agent=self._agent,
                current_timeout=self._timeout,
                current_claude_md=self._claude_md_path,
                current_hook_cfg=self._hook_cfg,
            )

            # First load: apply directly. Subsequent: confirm.
            old_path = self._jupyter_config_path
            if not old_path:
                _os.environ["JUPYTER_CONFIG_PATH"] = path
                self._jupyter_config_path = path
                summary = self._apply_config(resolved)
                send_to_panel(self.ns, "text", content=(
                    f"\n{'─'*50}\n✓ Config loaded\n"
                    f"  path    : {path}\n"
                    f"  agent   : {self._agent}\n"
                    f"  timeout : {self._timeout}s\n"
                    f"  changes : {summary}\n"
                    f"{'─'*50}\n"))
            else:
                self._config_pending = (resolved, path, old_path)
                new_agent = resolved.get('agent', self._agent)
                new_timeout = resolved.get('timeout', self._timeout)
                send_to_panel(self.ns, "text", content=(
                    f"\n{'─'*50}\n"
                    f"  Current\n"
                    f"    path    : {old_path}\n"
                    f"    agent   : {self._agent}\n"
                    f"    timeout : {self._timeout}s\n"
                    f"  ──────────────────────────────\n"
                    f"  New\n"
                    f"    path    : {path}\n"
                    f"    agent   : {new_agent}\n"
                    f"    timeout : {new_timeout}s\n"
                    f"{'─'*50}\n"
                    f"Press y to apply  n to cancel  Esc to dismiss\n"))
        else:
            pending = getattr(self, '_config_pending', None)
            if pending:
                _res, new_p, old_p = pending
                send_to_panel(self.ns, "text", content=(
                    f"\n{'─'*40}\n"
                    f"  Config Status\n"
                    f"  {'─'*40}\n"
                    f"  path    : {old_p}\n"
                    f"  agent   : {self._agent}\n"
                    f"  timeout : {self._timeout}s\n"
                    f"  claude-md: {self._claude_md_path or '(none)'}\n"
                    f"  {'─'*40}\n"
                    f"  Pending : {new_p}\n"
                    f"  Press y to apply  n to cancel\n"
                    f"{'─'*40}\n"))
            elif self._jupyter_config_path:
                send_to_panel(self.ns, "text", content=(
                    f"\n{'─'*40}\n"
                    f"  Config Status\n"
                    f"  {'─'*40}\n"
                    f"  path    : {self._jupyter_config_path}\n"
                    f"  agent   : {self._agent}\n"
                    f"  timeout : {self._timeout}s\n"
                    f"  claude-md: {self._claude_md_path or '(none)'}\n"
                    f"  {'─'*40}\n"))
            else:
                send_to_panel(self.ns, "text",
                              content="No config loaded. Usage: /config <path/to/config.yaml>\n")

    def _handle_cell_restore(self, text: str) -> None:
        """Handle /cell-snapshot-restore <cell_id> <version> — restore a cell snapshot."""
        from .cell_snapshot import restore
        parts = text.split()
        if len(parts) < 3:
            send_to_panel(self.ns, "text", content="Usage: /cell-snapshot-restore <cell_id> <version>\n")
            return
        cell_id = parts[1]
        version = parts[2]
        # NOTE: snapshots are bucketed by notebook path (see save/list_versions),
        # so restore MUST pass the same nb_path or it looks in the wrong bucket
        # and reports "version vNNNN not found".
        code = restore(cell_id, version, nb_path=_notebook_path())
        if code is None:
            send_to_panel(self.ns, "text", content=f"Version {version} not found.\n")
            return
        self._restoring_cells.add(cell_id)
        from .comm import send_cell_via_comm
        send_cell_via_comm(self.ns, code, auto=False, cell_type="code", replace_cell_id=cell_id)
        self._cell_restored = True
        print("Cell restored to " + version, flush=True)

    def _handle_cell_optimize(self, text: str) -> None:
        """Handle /cell-optimize <json_payload> — agent improves a specific cell."""
        if self._state != AgentState.IDLE:
            send_to_panel(self.ns, "text", content="⏳ agent is working, please wait...\n")
            return

        import json
        try:
            payload = json.loads(text[15:].strip())
        except json.JSONDecodeError:
            send_to_panel(self.ns, "text", content="✗ invalid payload\n")
            return

        cell_id = payload.get("cellId", "")
        code = (payload.get("code") or "").strip()
        output = (payload.get("output") or "").strip()
        error_msg = (payload.get("error") or "").strip()
        request = (payload.get("request") or "improve this code").strip()
        auto_exec = payload.get("auto", False)
        revise = payload.get("revise", False)
        run_below = payload.get("run_below", False)
        cells_manifest = payload.get("cells") or []
        selection = payload.get("selection")
        if not code:
            send_to_panel(self.ns, "text", content="✗ cell is empty\n")
            return

        has_selection = selection and isinstance(selection, dict) and selection.get("start") is not None
        sel_start = selection["start"] if has_selection else 0
        sel_end = selection["end"] if has_selection else 0
        sel_text = (selection.get("text") or "").strip()

        is_sql = code.startswith("%%sql")
        lang = "SQL" if is_sql else "Python"

        if has_selection and sel_text:
            code_before = code[:sel_start]
            code_after = code[sel_end:]
            code_for_prompt = f"{code_before[:2000]}{'...' if len(code_before) > 2000 else ''}\n" \
                             f"# === SELECTED CODE ===\n{sel_text[:3000]}\n" \
                             f"# === END SELECTED ===\n" \
                             f"{code_after[:2000]}{'...' if len(code_after) > 2000 else ''}"
            prompt = (
                f"## Current {lang} Cell\n"
                f"```\n{code_for_prompt}\n```\n\n"
                f"## The selected code (between === markers) needs to be modified.\n"
                f"The code BEFORE and AFTER the selection must be preserved exactly.\n"
                f"## Output\n```\n{output[:2000] or '(none)'}\n```\n"
            )
            if error_msg:
                prompt += f"\n## Error\n```\n{error_msg[:2000]}\n```\n"
            prompt += (
                f"\n## Request\n{request}\n\n"
                f"Return ONLY the NEW code to REPLACE the selected portion. "
                f"Do NOT include the code before/after the selection. "
                f"Do NOT add explanations. "
                f"Return ONLY the {lang} code in a fenced code block."
            )
        else:
            code_for_prompt = code[:5000]
            if len(code) > 5000:
                code_for_prompt += f"\n# ... ({len(code) - 5000} more chars)"
            prompt = (
                f"## Current {lang} Cell\n```{lang.lower()}\n{code_for_prompt}\n```\n\n"
                f"## Output\n```\n{output[:2000] or '(none)'}\n```"
            )
            if error_msg:
                prompt += f"\n## Error\n```\n{error_msg[:2000]}\n```\n"
            if revise:
                prompt += (
                    f"\n## Revised approach for this step\n{request}\n\n"
                    f"Rewrite THIS step's {lang} to follow the revised approach above. "
                    f"Keep the same output variable name(s) so the downstream steps "
                    f"still work. Return ONLY the rewritten {lang} in one fenced code "
                    f"block. Do NOT add explanations."
                )
            else:
                prompt += (
                    f"\n## Request\n{request}\n\n"
                    f"Return ONLY the improved {lang} code in a fenced code block. "
                    f"Do NOT add explanations."
                )

        try:
            self._ensure_session()
        except KeyboardInterrupt:
            self._interrupt_cleanup()
            return
        except Exception:
            _log.exception("_handle_cell_optimize: session init failed")
            send_to_panel(self.ns, "text", content="✗ session init failed\n")
            return

        verb = "revising" if revise else "optimizing"
        if has_selection:
            send_to_panel(self.ns, "text", content=f"↻ {verb} selected {lang}...\n")
        else:
            send_to_panel(self.ns, "text", content=f"↻ {verb} {lang} cell...\n")
        self._state = AgentState.STREAMING
        self._busy = True
        raw, interrupted = self._stream_with_interrupt(prompt)
        if interrupted:
            return
        if not raw.strip():
            self._finish_agent_run("Optimization failed (no output)")
            return

        result = parse(raw)
        if result.code_list:
            optimized = result.code_list[-1]

            if has_selection:
                new_code = code_before + optimized + code_after
                optimized = new_code

            from .render import render_code
            run_ids: list = []
            if run_below and cells_manifest:
                from .depgraph import dependent_cells
                manifest = [
                    {"id": c.get("id"), "exec": c.get("exec"),
                     "code": optimized if c.get("id") == cell_id else (c.get("code") or "")}
                    for c in cells_manifest
                ]
                run_ids = dependent_cells(manifest, cell_id)
            render_code(self.ns, optimized, auto=auto_exec, replace_cell_id=cell_id,
                        run_below=run_below and not run_ids, run_cell_ids=run_ids)
            self.ns.remove_cell_by_id(cell_id)
            self.ns.track_context(
                f"[cell {cell_id[:8]}] {'revised' if revise else 'optimized'} ({lang}): {request}\n"
                f"  old: {code[:100]}{'...' if len(code) > 100 else ''}\n"
                f"  new: {optimized[:100]}{'...' if len(optimized) > 100 else ''}")
            if revise:
                if run_ids:
                    n = len(run_ids)
                    action = f"revised & re-ran {n} dependent cell{'s' if n != 1 else ''}"
                elif run_below:
                    action = "revised & re-ran downstream"
                else:
                    action = "revised"
            else:
                action = "optimized & run" if auto_exec else "optimized"
            send_to_panel(self.ns, "text", content=f"✓ {lang} cell {action}\n")
        else:
            send_to_panel(self.ns, "text", content="✗ no code in agent response\n")
        self._finish_agent_run()

    def _handle_panel_confirm(self, arg: str) -> None:
        """Handle /confirm from panel."""
        arg = arg.strip()
        if not arg:
            return

        if arg == "yes":
            if self._last_plan_result is not None:
                self._implement_plan(self._last_plan_output or "", auto=True,
                                     preparsed_result=self._last_plan_result)
                self._record_state("plan_confirm")
            self._last_plan_output = ""
            self._last_plan_result = None
            send_to_panel(self.ns, "result", summary="")
        elif arg == "accept_edits":
            if self._last_plan_result is not None:
                self._implement_plan(self._last_plan_output or "", auto=False,
                                     preparsed_result=self._last_plan_result)
                self._record_state("plan_confirm")
            self._last_plan_output = ""
            self._last_plan_result = None
            send_to_panel(self.ns, "result", summary="")
        elif arg == "no":
            self._last_plan_output = ""
            self._finish_agent_run("Plan cancelled")
        else:
            # Revision feedback
            send_to_panel(self.ns, "text", content=f"↻ revising plan: {arg}\n")
            plan = self._last_plan_output or ""
            prompt = self._last_plan_prompt or ""
            if plan and prompt:
                full = f"User feedback on the plan: {arg}\n\nOriginal request:\n{prompt}\n\nPrevious plan:\n{plan}\n\nRevise the plan based on the feedback."
                self._state = AgentState.STREAMING
                self._busy = True
                raw, interrupted = self._stream_with_interrupt(full)
                if interrupted:
                    return
                if raw.strip():
                    self._last_plan_output = raw.strip()
                    result = parse(raw)
                    plan_text = result.plan or result.text or ""
                    self._state = AgentState.PLAN_REVIEW
                    self._busy = False
                    send_to_panel(self.ns, "plan_confirm", summary=plan_text)
                    send_to_panel(self.ns, "ready")
                else:
                    self._last_plan_output = ""
                    send_to_panel(self.ns, "text", content="✗ plan revision failed (no output)\n")
                    send_to_panel(self.ns, "result", summary="")
            else:
                send_to_panel(self.ns, "text", content="✗ no plan to revise\n")
                send_to_panel(self.ns, "result", summary="")

    def _auto_fix_cell(self, code: str, error_msg: str) -> None:
        """Auto mode: cell execution failed → ask AI to fix and replace in-place."""
        if self._state == AgentState.AUTO_FIXING:
            _log.warning("auto-fix: already fixing, skipping recursive call")
            return
        self._state = AgentState.AUTO_FIXING
        self._record_state("auto_fix")
        try:
            self._auto_fix_cell_impl(code, error_msg)
        finally:
            if self._state == AgentState.AUTO_FIXING:
                self._state = AgentState.STREAMING

    def _auto_fix_cell_impl(self, code: str, error_msg: str) -> None:
        self._busy = True
        self._auto_fix_count += 1
        if self._auto_fix_count >= 3:
            _log.warning("auto-fix: retry limit reached (%d)", self._auto_fix_count)
            self._auto_pending = 0
            self._finish_agent_run("Auto-fix retry limit reached")
            return

        # Find the cell_id for this code to replace in-place
        cell_id = ""
        for r in self._round_results:
            if (r.get("code", "") or "").strip() == code.strip():
                cell_id = r.get("cell_id", "")
                break

        _log.info("auto-fix #%d: cell=%s error=%s", self._auto_fix_count, cell_id or "(new)", error_msg[:100])
        action = "replacing failed cell" if cell_id else "inserting fix below"
        send_to_panel(self.ns, "text",
            content=f"\n⚠ execution error (attempt {self._auto_fix_count}/3) — {action}:\n{error_msg}\n")

        # Strip magic markers that could confuse the AI
        clean_code = code
        for marker in ["\n%confirm", "\n%agent", "\n# %%agent generate code"]:
            clean_code = clean_code.replace(marker, "")

        prompt = (
            f"The following code cell failed with an error. "
            f"Analyze the error and provide a corrected version of the code.\n\n"
            f"## Error\n```\n{error_msg}\n```\n\n"
            f"## Failed Code\n```python\n{clean_code}\n```\n\n"
            f"IMPORTANT: Output ONLY the corrected Python code in a fenced code block. "
            f"Do NOT include any Jupyter magic commands (like %confirm or %agent). "
            f"Do not add explanations."
        )
        raw, interrupted = self._stream_with_interrupt(prompt)
        if interrupted:
            return
        if raw.strip():
            result = parse(raw)
            if result.code_list:
                fixed_code = result.code_list[0]
                from .render import render_code
                self._auto_pending += 1
                render_code(self.ns, fixed_code, auto=True, replace_cell_id=cell_id)
                send_to_panel(self.ns, "text",
                    content="✓ auto-fixed (replaced)\n" if cell_id else "✓ auto-fixed (new cell)\n")
                if self._auto_fix_count >= 2:
                    self._finish_agent_run()
                    return
            else:
                self._finish_agent_run("Auto-fix: no code in response")
                return
        else:
            self._finish_agent_run("Auto-fix: no output")
            return

    def _implement_plan(self, plan: str, auto: bool = False,
                        preparsed_result=None) -> None:
        """Execute a confirmed plan: inject code blocks if present, or send as implementation prompt."""
        result = preparsed_result if preparsed_result is not None else parse(plan)
        _log.info("plan implement: %d code blocks, auto=%s", len(result.code_list), auto)

        self._agent_cells.clear()
        self._auto_fix_count = 0

        if result.code_list:
            if auto:
                self._state = AgentState.STREAMING
                self._busy = True
                self._auto_pending = len(result.code_list)
                self._build_steps(result.code_list)
                render_output(self.ns, result, auto=True, on_cell_id=self._track_agent_cell)
                if self._auto_pending == 0:
                    self._finish_agent_run()
                    return
            else:
                self._confirm_code_or_ask(result)
            label = "✓ plan implemented\n" if auto else "✓ plan accepted (code cells generated)\n"
            send_to_panel(self.ns, "text", content=label)
            return

        # Plan has no code blocks → stream implementation prompt
        prompt = self._last_plan_prompt or ""
        send_to_panel(self.ns, "text", content="↻ implementing plan...\n")
        full = (
            "[System: Plan mode has ended. The plan has been approved. "
            "You are now in implementation mode. "
            "Generate executable code cells to implement the approved plan below. "
            "Write complete, working code that the user can run directly — "
            "do NOT output plan descriptions or markdown explanations.]\n\n"
            f"## Approved Plan\n\n{plan}\n\n"
            "Implement this plan by writing executable code cells."
        )
        if prompt:
            full = f"Original request:\n{prompt}\n\n{full}"

        self._state = AgentState.STREAMING
        self._busy = True
        raw, interrupted = self._stream_with_interrupt(full)
        if interrupted:
            return
        if not raw.strip():
            self._finish_agent_run("Plan implementation failed (no output)")
            return

        result = parse(raw)
        if auto:
            self._state = AgentState.STREAMING
            self._auto_pending = len(result.code_list)
            render_output(self.ns, result, auto=True, on_cell_id=self._track_agent_cell)
            if self._auto_pending == 0:
                self._finish_agent_run()
        elif result.code_list:
            self._confirm_code_or_ask(result)
        else:
            self._resolve_no_code(result)
        send_to_panel(self.ns, "text", content="✓ plan implemented\n" if auto else "✓ plan accepted (code cells generated)\n")

    # ---- agent_config ----

    def _apply_config(self, resolved: dict) -> str:
        """Apply resolved config and rebuild session if needed. Shared by
        %agent_config and /config. Returns a summary string."""
        self._config_pending = None
        changes: list[str] = []
        agent = resolved["agent"]
        timeout = resolved["timeout"]
        claude_md_path = resolved["claude_md"]
        self._hook_cfg = resolved["hook_cfg"]
        self._tools_cfg = resolved["tools_cfg"]

        if agent not in _AGENTS:
            render_error(f"[agent_config] unknown agent '{agent}', valid: {', '.join(sorted(_AGENTS))}")
            agent = self._agent

        if agent != self._agent:
            changes.append(f"agent: {self._agent} → {agent}")
        if timeout != self._timeout:
            changes.append(f"timeout: {self._timeout}s → {timeout}s")
        if claude_md_path != self._claude_md_path:
            changes.append(f"claude_md: {claude_md_path}")

        if resolved["session_rebuild"]:
            if self._session_ready:
                self._session.cleanup()
                self._session_ready = False  # lazy re-init on next query
            changes.append("session will rebuild on next query")
        elif timeout != self._timeout:
            if self._session_ready and self._session.client is not None:
                self._session.client._backend._timeout = timeout
            changes.append("timeout updated (hot)")

        self._agent = agent
        self._timeout = timeout
        self._claude_md_path = claude_md_path
        return ", ".join(changes) if changes else "no changes"

    @line_magic("agent_config")
    def agent_config_func(self, line: str) -> None:
        """%agent_config [--config PATH] [--agent NAME] [--timeout N] [--claude-md PATH] [--debug] [--KEY=VALUE ...]"""
        args = shlex.split(line)

        config_path = pop_flag(args, "--config")
        cli_agent = pop_flag(args, "--agent")
        cli_timeout = pop_flag(args, "--timeout", convert=int)
        cli_claude_md = pop_flag(args, "--claude-md")
        cli_debug = "--debug" in args
        if cli_debug:
            args.remove("--debug")
        if "--no-debug" in args:
            args.remove("--no-debug")
            cli_debug = False
        if "--plan" in args:
            args.remove("--plan")  # mode driven by frontend
        if "--no-plan" in args:
            args.remove("--no-plan")
        env_vars = parse_kv(args)

        enable_hooks: list[str] = []
        disable_hooks: list[str] = []
        while "--enable-hook" in args:
            idx = args.index("--enable-hook")
            if idx + 1 < len(args):
                enable_hooks.append(args.pop(idx + 1))
            args.pop(idx)
        while "--disable-hook" in args:
            idx = args.index("--disable-hook")
            if idx + 1 < len(args):
                disable_hooks.append(args.pop(idx + 1))
            args.pop(idx)

        resolved = configure_agent(
            config_path=config_path,
            cli_agent=cli_agent, cli_timeout=cli_timeout,
            cli_claude_md=cli_claude_md, cli_debug=cli_debug,
            cli_env=env_vars,
            enable_hooks=enable_hooks, disable_hooks=disable_hooks,
            defaults={},
            current_agent=self._agent,
            current_timeout=self._timeout,
            current_claude_md=self._claude_md_path,
            current_hook_cfg=self._hook_cfg,
        )
        if config_path:
            self._jupyter_config_path = config_path
        summary = self._apply_config(resolved)
        render_info(f"agent: {self._agent}, timeout: {self._timeout}s [{summary}]")

    # ---- %sql / %%sql (line + cell magic) ----

    @line_magic("sql")
    @cell_magic("sql")
    def sql_func(self, line: str, cell: str = None) -> None:
        """%sql status|result|cancel [options]  |  %%sql [--var NAME] [--timeout N] [--poll N] | submit | result --job_id ID [--limit N]"""
        args = shlex.split(line)

        # ---- line magic: %sql status|result|cancel ----
        if cell is None:
            sub = args[0] if args else ""
            job_id = pop_flag(args, "--job_id")
            limit = pop_flag(args, "--limit", convert=int) or 100

            if not job_id:
                render_error("--job_id is required")
                return

            runner = SqlRunner()
            try:
                if sub == "status":
                    result = runner.status(job_id)
                    data = result.get("data", {})
                    render_info(f"job_id: {data.get('job_id', job_id)}")
                    render_info(f"status: {data.get('status', '?')}")
                    render_info(f"engine:  {data.get('engine_type', '?')}")
                elif sub == "cancel":
                    result = runner.cancel(job_id)
                    data = result.get("data", {})
                    requested = data.get("cancel_requested", "false")
                    render_info(f"job_id: {data.get('job_id', job_id)}  cancel_requested: {requested}")
                elif sub == "result":
                    var_name = pop_flag(args, "--var") or self.ns.next_sql_var()
                    result = runner.result(job_id, limit=limit)
                    render_sql_dataframe(self.ns,result.get("data", {}), var_name)
                else:
                    render_error(f"unknown subcommand: {sub}. Use: status | cancel | result")
            except RuntimeError as e:
                render_error(f"{e}")
            return

        # ---- cell magic: %%sql [query|submit] ----
        mode = args[0] if args and not args[0].startswith("--") else "query"

        if mode == "submit":
            try:
                result = SqlRunner().submit(cell)
                job_id = result.get("data", {}).get("job_id", "")
                render_info(f"job submitted: {job_id}")
            except RuntimeError as e:
                render_error(f"{e}")
        else:
            var_name = pop_flag(args, "--var")
            timeout = pop_flag(args, "--timeout", convert=int) or 600
            poll = pop_flag(args, "--poll", convert=int) or 30
            runner = SqlRunner(poll_interval=poll, timeout=timeout)
            try:
                result = runner.query(cell, on_progress=sql_progress)
                data = result.get("data", {})
                if not var_name:
                    var_name = self.ns.next_sql_var()
                df = render_sql_dataframe(self.ns, data, var_name)
                if df is not None:
                    render_info(f"sql query: var={var_name} rows={len(df)} sql={cell[:500]}")
                else:
                    render_error("sql query returned no data")
                    _log.error(f"sql={cell[:500]}")
            except (RuntimeError, TimeoutError) as e:
                render_error(str(e))
                _log.error(f"sql query error: {e}")

    # Agent interaction now handled via right-side panel only
