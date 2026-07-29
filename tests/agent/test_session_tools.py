"""Tests for AgentSession._stream tool-use callback wiring.

Regression guard for the bug where telemetry's ``tool_names`` was always empty:
``_stream`` tracked tools in a local set that was never exposed, so callers
recording ``tool_names`` logged nothing. The fix routes each ``tool_use`` block
through an ``on_tool_use`` callback.
"""

import sys
sys.path.insert(0, "src")

from agent.session import AgentSession
from chat.base import StreamChunk, TraceBlock


class _FakeBackend:
    """Minimal backend that replays a scripted list of StreamChunks."""

    def __init__(self, chunks):
        self._chunks = chunks
        self._timeout = 60

    def stream_chunks(self, prompt, session=None):
        yield from self._chunks


class _FakeClient:
    def __init__(self, chunks):
        self._backend = _FakeBackend(chunks)


def _run(chunks, **kwargs):
    """Drive _stream over a scripted client, returning (raw, seen_tools)."""
    seen: list[str] = []
    raw = AgentSession._stream(
        _FakeClient(chunks), "do something", "sess-1",
        show_text=False, on_tool_use=seen.append, **kwargs,
    )
    return raw, seen


def test_on_tool_use_receives_each_tool():
    chunks = [
        StreamChunk(blocks=[TraceBlock(type="tool_use",
                                       data={"name": "Bash", "input": {"command": "ls"}})]),
        StreamChunk(blocks=[TraceBlock(type="tool_use",
                                       data={"name": "Read", "input": {"file_path": "a.py"}})]),
        StreamChunk(text="done"),
    ]
    raw, seen = _run(chunks)
    assert raw == "done"
    # order preserved, one call per tool_use block
    assert seen == ["Bash", "Read"]


def test_tool_names_set_dedupes_repeated_tools():
    """The caller collects into a set — repeated tools collapse, like magic.py."""
    chunks = [
        StreamChunk(blocks=[TraceBlock(type="tool_use", data={"name": "Bash", "input": {}})]),
        StreamChunk(blocks=[TraceBlock(type="tool_use", data={"name": "Bash", "input": {}})]),
        StreamChunk(blocks=[TraceBlock(type="tool_use", data={"name": "Grep", "input": {}})]),
    ]
    tool_names: set[str] = set()
    AgentSession._stream(
        _FakeClient(chunks), "p", "s",
        show_text=False, on_tool_use=tool_names.add,
    )
    assert tool_names == {"Bash", "Grep"}


def test_no_callback_is_safe():
    """Omitting on_tool_use must not raise (back-compat with old callers)."""
    chunks = [
        StreamChunk(blocks=[TraceBlock(type="tool_use", data={"name": "Bash", "input": {}})]),
        StreamChunk(text="ok"),
    ]
    raw = AgentSession._stream(_FakeClient(chunks), "p", "s", show_text=False)
    assert raw == "ok"


def test_missing_tool_name_falls_back_to_placeholder():
    chunks = [StreamChunk(blocks=[TraceBlock(type="tool_use", data={"input": {}})])]
    _, seen = _run(chunks)
    assert seen == ["?"]


def test_non_tool_blocks_do_not_trigger_callback():
    chunks = [
        StreamChunk(blocks=[TraceBlock(type="thinking", data={"thinking": "hmm"})]),
        StreamChunk(blocks=[TraceBlock(type="tool_result", data={"content": "out"})]),
        StreamChunk(text="answer"),
    ]
    raw, seen = _run(chunks)
    assert seen == []
    assert "answer" in raw
