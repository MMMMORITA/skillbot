# Unified execution permissions

## Scope
Application-level policy for Claude SDK tools and agent-generated notebook cells.
Not an OS sandbox, multi-tenant authentication layer, or arbitrary-code classifier.
Preserve unrelated uncommitted Comm, rendering, and Cell-reference work.

## Phases
1. Inspect existing mode, confirmation, SDK and dispatch paths: complete.
2. Implement shared policy, request propagation and SDK pre-tool gate: complete.
3. Enforce workflow-scoped notebook authorization and update prompts: complete.
4. Run policy, transport, lifecycle and notebook regressions; document limits: complete.
5. Save the acceptance notebook, restart its kernel and verify the real UI flows: complete.

## Decisions
- Deny by default; unknown tools and modes do not gain permission.
- Plan/default requests are read-only. Execute/auto allow scoped artifact writes.
- Bash, native delegation and unregistered external tools are denied in this MVP.
- Reused SDK sessions must re-evaluate the current request policy.
- Manual kernel execution remains trusted; Cell permissions govern agent dispatch.

## Errors
- No AGENTS.md exists in this checkout; follow workspace instructions.
- Initial Chat integration run hit the old server and failed the new version handshake
  (12 failures, 98 passes, 34 skips); update/restart and rerun before acceptance.
- SDK can_use_tool requires connect() followed by query(), not connect(prompt=str).
  Updated all three response paths; real SDK allow/deny smoke passed.
- Repeated live HTTP run returned code for a counting-text prompt. Narrowed the
  advisory policy note; all three affected text/read streaming checks passed.
- Direct wheel validation unavailable because hatchling is missing; not claimed.
- Built-in browser displayed a notebook but menus did not respond and the extension
  reported an undefined connect signal. Preserve original content and verify using
  an independent Playwright browser before deciding whether code changes are needed.

## Acceptance
- 285 focused regressions passed; real SDK Auto allow -> Plan deny passed.
- HTTP first full run passed 12 tests; later content regression fixed and three
  targeted live checks passed. Exact runs are recorded in progress.md.
- Updated local Claude service is running with permission_policy_version=1.
- Wheel build remains unverified and is explicitly documented.
- No commits, pushes, or unrelated worktree reverts were performed.
- Browser acceptance subsequently passed for Default confirmation, Plan edit-only,
  Auto execution and stale-confirm rejection. Notebook save and Kernel restart verified.
- JupyterLab 4.6 deletion-listener compatibility was fixed and the extension rebuilt.
