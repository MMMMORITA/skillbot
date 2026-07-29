"""Regression guard: silent streaming must not surface to the panel.

The plan-mode double/triple-output bug came from an *internal* round-trip:
after the first reply, ``_rescue_gate_from_text`` streamed a second time to
re-express a prose choice as a decision_gate. That rescue's raw output is
machine-parsed (not shown), but its ``on_chunk`` still pushed every chunk to the
panel, so the user saw the answer twice (three times once the plan card landed),
and telemetry logged a phantom extra ``agent_response`` for one prompt.

The fix adds ``silent=True`` to ``_stream_with_interrupt``. These tests pin that
contract: silent runs emit no ``text``/``thinking`` to the panel and record no
``agent_response``; non-silent runs still do.
"""

import sys
sys.path.insert(0, "src")

import jupyter.magic as magic
from jupyter.magic import AgentMagic


class _FakeSession:
    """Session stub whose stream() replays scripted text through on_chunk."""

    def __init__(self, text="hello world"):
        self._text = text

    def stream(self, prompt, show_text=True, on_chunk=None,
               on_thinking=None, on_tool_use=None):
        if on_thinking:
            on_thinking("pondering")
        if on_chunk:
            on_chunk(self._text)
        return self._text


class _RecordingRecorder:
    def __init__(self):
        self.events = []

    def record(self, event, **data):
        self.events.append((event, data))


def _make_magic():
    """Build an AgentMagic without its heavy __init__, wired for streaming."""
    m = AgentMagic.__new__(AgentMagic)
    m.ns = object()
    m._session = _FakeSession()
    m._session_dirty = False
    m._last_mode = "default"
    return m


def _capture_panel(monkeypatch):
    """Intercept every send_to_panel / send_thinking call in magic.py."""
    calls = []
    monkeypatch.setattr(magic, "send_to_panel",
                        lambda ns, action, **d: calls.append((action, d)) or True)
    monkeypatch.setattr(magic, "send_thinking",
                        lambda content: calls.append(("thinking", {"content": content})) or True)
    return calls


def test_silent_stream_emits_nothing_to_panel(monkeypatch):
    m = _make_magic()
    calls = _capture_panel(monkeypatch)
    monkeypatch.setattr(magic, "get_recorder", lambda: None)

    raw, interrupted = m._stream_with_interrupt("internal directive", silent=True)

    assert raw == "hello world"
    assert interrupted is False
    assert calls == [], f"silent run leaked to panel: {calls}"


def test_visible_stream_streams_text_to_panel(monkeypatch):
    m = _make_magic()
    calls = _capture_panel(monkeypatch)
    monkeypatch.setattr(magic, "get_recorder", lambda: None)

    m._stream_with_interrupt("a real user turn")  # silent defaults to False

    actions = [a for a, _ in calls]
    assert "text" in actions, f"visible run should stream text, got {actions}"
    # the streamed prose chunk must reach the panel verbatim
    assert any(d.get("content") == "hello world" for a, d in calls if a == "text")


def test_silent_stream_records_no_agent_response(monkeypatch):
    m = _make_magic()
    _capture_panel(monkeypatch)
    rec = _RecordingRecorder()
    monkeypatch.setattr(magic, "get_recorder", lambda: rec)

    m._stream_with_interrupt("internal directive", silent=True)

    assert not any(ev == "agent_response" for ev, _ in rec.events), \
        f"silent run polluted telemetry: {rec.events}"


def test_visible_stream_records_agent_response(monkeypatch):
    m = _make_magic()
    _capture_panel(monkeypatch)
    rec = _RecordingRecorder()
    monkeypatch.setattr(magic, "get_recorder", lambda: rec)

    m._stream_with_interrupt("a real user turn")

    assert any(ev == "agent_response" for ev, _ in rec.events), \
        "visible run should record exactly one agent_response"
