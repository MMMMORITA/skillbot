"""Unified chat client for deer-flow / nanobot / hermes-agent / claude-code."""

import os
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Optional

from .base import (
    AbstractBackend,
    AgentNotInstalledError,
    AgentStartupTimeout,
    ChatError,
    StreamChunk,
)
from .claude import ClaudeBackend
from .deerflow import DeerFlowBackend
from .hermes import HermesBackend
from .nanobot import NanobotBackend
from .skill import SkillManager

__all__ = [
    "ChatClient",
    "ChatError",
    "AgentNotInstalledError",
    "AgentStartupTimeout",
]

_AGENTS = {"deer-flow", "nanobot", "hermes-agent", "claude-code"}

_PROJECT_DIR = Path(__file__).resolve().parents[2]

# Agents whose runtime skill directory lives under $HOME (config is synced there
# by run.sh, e.g. conf/agent_conf/hermes-agent -> ~/.hermes). For these the UI
# must read the *same* directory the agent loads from, not the project copy —
# otherwise the skill list shown to the user drifts from what the agent uses.
_AGENT_HOME_SKILL_PATHS: dict[str, str] = {
    "hermes-agent": ".hermes/skills",
}

_AGENT_SKILL_PATHS: dict[str, str] = {
    "claude-code": ".claude/skills",
    "deer-flow": "skills/custom",
    "nanobot": "nanobot/skills",
    "hermes-agent": "skills",
}


def _resolve_skill_dir(agent: str) -> str:
    """Resolve the skill directory an agent actually loads from.

    hermes-agent reads ~/.hermes/skills at runtime (config is synced there by
    run.sh). An explicit SKILL_BOT_AGENT_INSTALL_DIR override still wins so
    tests and custom installs can redirect it.
    """
    install_dir = os.environ.get("SKILL_BOT_AGENT_INSTALL_DIR", "")
    if not install_dir and agent in _AGENT_HOME_SKILL_PATHS:
        return str(Path.home() / _AGENT_HOME_SKILL_PATHS[agent])
    base = Path(install_dir) if install_dir else _PROJECT_DIR / "agents"
    return str(base / agent / _AGENT_SKILL_PATHS.get(agent, "skills"))


class ChatClient:
    """Unified chat client across deer-flow / nanobot / hermes-agent.

    Usage::

        from chat import ChatClient

        c = ChatClient("nanobot")
        reply = c.chat("Hello", session="s1")
        print(reply)

        for chunk in c.stream("Tell a joke", session="s2"):
            print(chunk, end="")
    """

    def __init__(
        self,
        agent: str,
        model: Optional[str] = None,
        auto_start: bool = True,
        timeout: int = 120,
    ) -> None:
        if agent not in _AGENTS:
            raise ValueError(f"Unknown agent '{agent}'. Choose: {', '.join(sorted(_AGENTS))}")

        self._agent = agent
        self._model = model

        if agent == "deer-flow":
            self._backend: AbstractBackend = DeerFlowBackend(model=model, timeout=timeout)
        elif agent == "nanobot":
            self._backend = NanobotBackend(model=model, auto_start=auto_start, timeout=timeout)
        elif agent == "hermes-agent":
            self._backend = HermesBackend(model=model, auto_start=auto_start, timeout=timeout)
        elif agent == "claude-code":
            self._backend = ClaudeBackend(model=model, auto_start=auto_start, timeout=timeout)
        else:
            raise ValueError(f"Unknown agent: {agent}")

        self.skills = SkillManager(_resolve_skill_dir(agent))
        self._skill_version: tuple | None = None  # detect enable/disable changes

    # ------------------------------------------------------------------
    # skill helpers
    # ------------------------------------------------------------------

    def _maybe_inject_skills(self, content: str) -> str:
        """Inject skill prompt when config changes.

        claude-code: injects a minimal delta notice on mid-session changes
        (SDK handles full loading at startup).
        Other agents: injects full skill body via SkillManager.inject_prompt().
        """
        # Keyword retrieval narrows the catalog per message, so the catalog
        # depends on `content` — bypass the config-version cache when active.
        topk = self._skill_topk()
        if topk and self._agent != "claude-code":
            progressive = self._progressive_enabled()
            prompt = self.skills.inject_prompt(
                progressive=progressive, query=content, top_k=topk,
                rerank=self._rerank_enabled(),
            )
            return prompt + "\n\n" + content if prompt else content

        current = (
            tuple(self.skills.active_skills),
            tuple(self.skills.disabled_skills),
        )
        if current == self._skill_version:
            return content  # config unchanged

        prev_active = set(self._skill_version[0]) if self._skill_version else set()
        prev_disabled = set(self._skill_version[1]) if self._skill_version else set()
        was_none = self._skill_version is None
        self._skill_version = current

        new_active = set(self.skills.active_skills)
        new_disabled = set(self.skills.disabled_skills)
        enabled = new_active - prev_active
        disabled = new_disabled - prev_disabled

        if self._agent == "claude-code":
            # First query: SDK handles skills, no injection needed
            if was_none:
                return content
            # Mid-session change: inject delta notice
            if not enabled and not disabled:
                return content
            parts = []
            if enabled:
                parts.append(f"skill ENABLED: {', '.join(sorted(enabled))}")
            if disabled:
                parts.append(f"skill DISABLED (do NOT use): {', '.join(sorted(disabled))}")
            return "[System note: skill configuration changed]\n" + "\n".join(parts) + "\n\n" + content

        # Non-claude agents: prompt injection.
        # Progressive mode (env-gated) injects only a routing layer
        # (name + description + path) instead of every skill's full body,
        # so enabling many skills no longer blows up the context window.
        prompt = self.skills.inject_prompt(progressive=self._progressive_enabled())
        if prompt:
            return prompt + "\n\n" + content
        return content

    @staticmethod
    def _progressive_enabled() -> bool:
        return os.environ.get("SKILLBOT_PROGRESSIVE_SKILLS", "") not in ("", "0", "false")

    @staticmethod
    def _skill_topk() -> int:
        """Catalog narrowing via keyword retrieval; 0/unset disables it."""
        raw = os.environ.get("SKILLBOT_SKILL_TOPK", "")
        try:
            return max(0, int(raw))
        except ValueError:
            return 0

    @staticmethod
    def _rerank_enabled() -> bool:
        """LLM rerank on the keyword candidate pool; off by default."""
        return os.environ.get("SKILLBOT_SKILL_RERANK", "") not in ("", "0", "false")

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------


    def chat(self, content: str, session: str = "default", model: Optional[str] = None) -> str:
        """Send a message and return the full response."""
        content = self._maybe_inject_skills(content)
        return self._backend.chat(content=content, session=session, model=model)

    async def async_chat(
        self, content: str, session: str = "default", model: Optional[str] = None
    ) -> str:
        """Async: send a message and return the full response."""
        content = self._maybe_inject_skills(content)
        return await self._backend.async_chat(content=content, session=session, model=model)

    def stream(self, content: str, session: str = "default", model: Optional[str] = None) -> Iterator[str]:
        """Send a message and yield response tokens."""
        content = self._maybe_inject_skills(content)
        yield from self._backend.stream(content=content, session=session, model=model)

    async def async_stream(
        self, content: str, session: str = "default", model: Optional[str] = None
    ) -> AsyncIterator[str]:
        """Async: send a message and yield response tokens."""
        content = self._maybe_inject_skills(content)
        async for chunk in self._backend.async_stream(content=content, session=session, model=model):
            yield chunk

    def stream_chunks(
        self, content: str, session: str = "default", model: Optional[str] = None
    ) -> Iterator[StreamChunk]:
        """Send a message and yield structured chunks with trace data."""
        content = self._maybe_inject_skills(content)
        yield from self._backend.stream_chunks(content=content, session=session, model=model)

    async def async_stream_chunks(
        self, content: str, session: str = "default", model: Optional[str] = None
    ) -> AsyncIterator[StreamChunk]:
        """Async: send a message and yield structured chunks with trace data."""
        content = self._maybe_inject_skills(content)
        async for chunk in self._backend.async_stream_chunks(content=content, session=session, model=model):
            yield chunk

    def list_sessions(self) -> list[str]:
        """Return tracked session IDs."""
        return self._backend.list_sessions()

    def clear_session(self, session: str) -> None:
        """Clear a session."""
        self._backend.clear_session(session)

    def interrupt(self, session: str) -> None:
        """Interrupt the current streaming query."""
        self._backend.interrupt(session)

    @property
    def agent(self) -> str:
        return self._agent
