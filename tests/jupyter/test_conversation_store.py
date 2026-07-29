"""Tests for per-notebook conversation persistence (save/load/list/delete)."""

import sys
sys.path.insert(0, "src")

import pytest

from jupyter import conversation_store as cs


@pytest.fixture
def store_dir(tmp_path, monkeypatch):
    """Redirect conversation storage to an isolated tmp dir."""
    d = tmp_path / "conversations"
    d.mkdir()
    monkeypatch.setattr(cs, "_conversations_dir", lambda: d)
    return d


def test_save_load_round_trip(store_dir):
    ok = cs.save_conversation("notebooks/foo.ipynb", '{"output":"hi"}')
    assert ok is True
    assert cs.load_conversation("notebooks/foo.ipynb") == '{"output":"hi"}'


def test_load_missing_returns_empty(store_dir):
    assert cs.load_conversation("nope.ipynb") == ""


def test_list_includes_saved(store_dir):
    cs.save_conversation("a.ipynb", "{}")
    cs.save_conversation("b.ipynb", "{}")
    paths = {r["path"] for r in cs.list_conversations()}
    assert {"a.ipynb", "b.ipynb"} <= paths


def test_delete_removes_file(store_dir):
    cs.save_conversation("gone.ipynb", "{}")
    assert cs.load_conversation("gone.ipynb") == "{}"
    assert cs.delete_conversation("gone.ipynb") is True
    assert cs.load_conversation("gone.ipynb") == ""
    # gone from the listing too
    assert all(r["path"] != "gone.ipynb" for r in cs.list_conversations())


def test_delete_missing_is_false(store_dir):
    assert cs.delete_conversation("never.ipynb") is False


def test_delete_empty_path_is_false(store_dir):
    assert cs.delete_conversation("") is False
