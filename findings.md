# Execution permission findings

- Before this change, Claude options used bypassPermissions and SDK tools and Cell
  confirmations were separate paths. Both now use the shared execution modes.
- SDK documentation in the installed types says can_use_tool alone misses already-allowed
  tools. PreToolUse must enforce the policy for every call.
- A Session caches its SDK client; passing different creation options on later requests
  does not update the running process. Use a callback bound to current request state.
- AgentSession initialization sends a real model request. It must remain read-only.
- Cell dispatch has multiple callers (continue, plan, auto, optimize, repair).
  Authorization must be checked centrally before dispatch and revoked at workflow end.
- Existing root-workspace planning files refer to historical branches; do not treat
  their completed milestones as current source guarantees.
- HTTP response generators must close the Session generator before releasing the
  session lock. Explicit aclosing now enforces this ordering for both stream routes.
- SDK stream cleanup errors must not skip client disconnect; nested finally covers it.
- Native Skill tools are disabled in this MVP. The running Claude installation also
  currently has no .claude/skills directory; do not claim knowledge-base runtime coverage.
- Wheel validation could not run directly because hatchling is absent from this venv.
  The build package list now includes agent, but no successful wheel build is claimed.
- Real JupyterLab 4.6 acceptance showed that deletion tracking must subscribe to
  `NotebookModel.cells.changed`; `sharedModel.cellsChanged` is undefined. Removed
  values may also be sparse, so the handler must tolerate empty entries.
- The existing Jupyter workspace occasionally logs aborted workspace-save requests.
  This did not prevent notebook saves, kernel restart, Cell creation or execution.
