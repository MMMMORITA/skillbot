"""Tests for Task."""

import sys
sys.path.insert(0, "src")

from uuid import uuid4

from task import Task


class TestTask:
    def test_create(self):
        t = Task(task_id="1", subject="test")
        assert t.task_id == "1"
        assert t.status == "pending"

    def test_metadata(self):
        t = Task(task_id="1", subject="r", metadata={"prompt": "hello", "results": []})
        assert t.metadata["prompt"] == "hello"

    def test_update_fields(self):
        t = Task(task_id="1", subject="a")
        t.status = "done"
        t.owner = "worker"
        assert t.status == "done"
        assert t.owner == "worker"


class TestTaskMetadata:
    def test_review_metadata(self):
        t = Task(task_id=uuid4().hex[:8], subject="review: code_review",
                 metadata={"sub_name": "code_review", "prompt": "is this done?",
                           "context": "ctx: var x=1", "results": []})
        assert t.subject == "review: code_review"
        assert t.metadata["prompt"] == "is this done?"
        assert t.metadata["results"] == []
