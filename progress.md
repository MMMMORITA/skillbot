# Progress

## 2026-09-08
- Inspected SDK, transport, session, mode and Cell dispatch paths.
- Recorded conservative MVP permissions and explicit non-sandbox boundary.
- Implementation and verification in progress; no completion claims yet.
- Implemented shared mode policy, HTTP propagation, SDK pre-tool enforcement and
  workflow-scoped Cell authorization. Added legacy dispatch and snapshot restore handling.
- New targeted tests: 96 passed. Jupyter regression: 182 passed.
- Real SDK smoke: 1 passed. In the same SDK process, Auto Write created a sentinel,
  Plan Write was actually attempted and denied by the hook; sentinel unchanged.
- Initial full Chat run used the old server: 12 expected version-guard failures.
  Server update/restart in progress; final HTTP regression pending.
- Updated and restarted Claude server; /health reports permission_policy_version=1.
- Real HTTP Chat regression after restart: 12 passed in 69.17s.
- Added HTTP generator close-before-unlock and SDK cleanup-failure regression tests;
  added Plan execute/edit and snapshot-restore scope tests.
- Final offline regression: 285 passed, 1 existing Starlette deprecation warning,
  in 5.37s. Python compileall and git diff --check passed.
- Added docs/execution-permissions.md with behavior, deployment, acceptance and limits.
- Last HTTP cleanup changes are being synced to the service for final live verification.
- Direct wheel check unavailable: hatchling is not installed (uv also unavailable).
  No package installation or successful wheel-build claim.
- Jupyter Kernel was not restarted; browser end-to-end permission acceptance remains
  manual. No commit/push and no unrelated worktree changes reverted.
- Final real SDK repeat: 1 passed in 10.58s (actual Auto allow -> Plan deny).
- Remaining Chat suite: 98 passed, 34 skipped in 5.06s.
- Repeated HTTP run: 11 passed, 1 failed. Counting text was returned as Python code,
  so the streaming content assertion failed. Narrowed the advisory permission note:
  ordinary questions get direct answers; only execution tasks return notebook code.
  Enforcement unchanged; updated service and rerunning the affected live tests.
- Service update's optional npm audit took about one minute; a subsequent update
  with offline/no-audit npm settings completed in 271ms. Runtime files match source.
- After the advisory-note correction, all 3 targeted real HTTP tests passed in
  13.22s (counting stream, one-word stream, scoped Read including sentinel content).
  Server unit/session tests: 31 passed in 2.27s.
- Final service is running on 127.0.0.1:9000 with permission_policy_version=1.
  git diff --check passed. Scope, limitations and exact non-additive results are
  recorded in docs/execution-permissions.md. Implementation phase complete.

## 2026-09-09
- Saved `.jupyter/run/comm_at_acceptance.ipynb`; Jupyter server logged the save.
- Restarted its kernel; server logged kernel `42b18648-99e1-4fce-a76f-3a82197ac104`
  restarted and the UI returned to Idle.
- Browser acceptance passed:
  - Default kept 3 cells before confirmation, then created/executed a cell with
    `[1]` and output `PERMISSION_DEFAULT_OK`.
  - Plan accept-edits created a code cell with `[ ]` and no output.
  - Auto created/executed a cell with `[4]` and output `PERMISSION_AUTO_OK`.
  - Stale `/confirm yes` returned `No pending plan confirmation.` and kept 7 cells.
  - Final save reported zero dirty tabs.
- Acceptance exposed a JupyterLab 4.6 incompatibility in deletion tracking:
  `sharedModel.cellsChanged` was undefined. Switched to `model.cells.changed`,
  disconnected the prior notebook listener, and guarded sparse removed values.
- Rebuilt and synced the labextension. A fresh visible JupyterLab workspace loads
  without the prior SkillBot `connect/sharedModel` exception.
- Jupyter tests: 186 passed. TypeScript no-emit compile and git diff check passed.
- Re-ran the Jupyter suite after the final sparse-value guard: 186 passed in 6.68s.
- Removed the temporary Playwright driver and the temporary Playwright packages.
- Left the visible `permission-final` Jupyter workspace open on the saved acceptance
  notebook. The final page load has no SkillBot initialization exception.
