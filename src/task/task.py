"""Generic task with dependencies."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Task:
    """A task carrying prompt/context/results for sub-agent execution.

    ``status``: pending → in_progress → done | failed
    """

    task_id: str
    subject: str
    description: str = ""
    status: str = "pending"
    owner: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
