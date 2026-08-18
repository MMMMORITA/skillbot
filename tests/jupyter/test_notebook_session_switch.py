from unittest.mock import patch

from jupyter.magic import AgentMagic, AgentState


class _Session:
    def __init__(self):
        self.cleanup_calls = 0

    def cleanup(self):
        self.cleanup_calls += 1


def _magic():
    magic = AgentMagic.__new__(AgentMagic)
    magic._state = AgentState.IDLE
    magic._session_nb_path = "a.ipynb"
    magic._pending_session_nb_path = None
    magic._session_ready = True
    magic._session_dirty = True
    magic._session = _Session()
    magic.ns = None
    return magic


def test_busy_notebook_switch_is_applied_after_task_finishes():
    magic = _magic()
    magic._state = AgentState.STREAMING

    magic._handle_notebook_switch("b.ipynb")

    assert magic._session_nb_path == "a.ipynb"
    assert magic._pending_session_nb_path == "b.ipynb"
    assert magic._session.cleanup_calls == 0

    magic._state = AgentState.IDLE
    with patch("jupyter.magic.send_to_panel"):
        magic._apply_pending_notebook_switch()

    assert magic._pending_session_nb_path is None
    assert magic._session_nb_path == "b.ipynb"
    assert magic._session.cleanup_calls == 1
    assert magic._session_ready is False
    assert magic._session_dirty is False


def test_latest_busy_notebook_switch_wins():
    magic = _magic()
    magic._state = AgentState.STREAMING

    magic._handle_notebook_switch("b.ipynb")
    magic._handle_notebook_switch("c.ipynb")

    magic._state = AgentState.IDLE
    with patch("jupyter.magic.send_to_panel"):
        magic._apply_pending_notebook_switch()

    assert magic._session_nb_path == "c.ipynb"
    assert magic._session.cleanup_calls == 1
