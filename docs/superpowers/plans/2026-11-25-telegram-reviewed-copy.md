# Telegram reviewed queue copy implementation plan

> Execute inline in the current feature branch, preserving unrelated edits.

**Goal:** Resume paused, unattempted Telegram jobs using the latest explicitly reviewed draft, without sending stale queue copies.

**Design:** Prepare reads the current draft body and exposes the exact new body plus the prior queued body when changed. Recipient addresses and numeric IDs stay unchanged. Execution revalidates current bodies, eligibility, limits, snapshot and future slots, updates the queued body in the same transaction, skips held contacts and only then unpauses. No delivery happens at prepare time.

**Alternatives:** SQL queue replacement would bypass the service confirmation guard and is rejected. Editing the paused queue through a prepare/execute transaction keeps its delivery identity and approval checks.

**Constraints:** No direct Telegram delivery; no recipient/consent changes; no automatic retry of attempted/uncertain jobs; explicit post-prepare approval is mandatory; existing limits remain intact. Preserve unrelated src/mcp/tool-handlers.js and tests/mcp/protected-tools.test.js changes.

**Execution ruling:** The user has repeatedly requested continuous execution. Native worktree creation did not return; that request was terminated. Work on the existing codex feature branch, stage only the task files, retain all other edits.

## One task: refresh reviewed queue bodies

- [ ] Add a PostgreSQL integration test: edited draft appears in prepare, queue remains unchanged, held and changed-address contacts are excluded, another edit invalidates execute, fresh approval writes the latest body while preserving random_id and consent.
- [ ] Run against a disposable database and confirm failure on stale-body rejection.
- [ ] Update src/services/telegram-profiles.js and MCP wording; preserve address and eligibility checks and exact confirmation snapshot.
- [ ] Update the existing resume integration test to include an edited draft instead of excluding it.
- [ ] Run targeted database tests, npm run check and npm run test:mcp.
- [ ] Review the diff, commit only these changes, deploy through the existing guarded deployment script.
- [ ] Prepare 18 current texts with fresh future windows; show summary and ask for final MCP approval. Do not execute without that approval.
