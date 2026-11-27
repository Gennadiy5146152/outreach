# Cabinet One-Off Two Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Each worker owns only its assigned files and must preserve other changes.

**Goal:** Prepare, explicitly approve and dispatch at most two additional Artem messages today, raise the permanent daily limit to 20, and extend the ordinary window by two hours to 12:02–15:55 as subsequently requested.

**Architecture:** Server-issued one_off_launch plan binds exact draft/recipient/body/schedule and job-specific date/window/ceiling. The worker interprets the exception only for those jobs on that day. Ordinary scheduling stays unchanged.

**Tech Stack:** Node.js, PostgreSQL, scoped MCP, Python/Telethon worker.

**Spec:** docs/superpowers/specs/2026-11-27-cabinet-one-off-two.md. User approved this scope in the current chat; implementation proceeds without another design approval.

## Global Constraints

- Never send before fresh human approval after the real MCP prepare.
- Current Moscow day only; maximum two drafts. Default ceiling regular limit+2 without changing settings; optional explicit daily_limit binds the permanent change and uses that exact ceiling. This run requests 20.
- Preserve owner/token isolation, all existing stops, identity, FloodWait and uncertain safeguards.
- No production writes during tests; preserve unrelated root edits.

## Review Focus

1. Approval crossing Moscow midnight/window end must fail or cancel without rescheduling.
2. Two concurrent/repeated plans cannot exceed the day ceiling or reuse a consumed token.
3. A changed body, receiver, pause, quota, connection generation/status or outstanding queue invalidates the plan.
4. Read/send-only/selected-campaign/cross-owner tokens cannot obtain the one-off exception.
5. Without a permanent change ordinary jobs retain their configured cap/window. With the explicit approved changes they use 20 and 12:02–15:55. The two one-off jobs remain bound to today's separately shown window; no other drafts are launched.

## Task A: Server, migration, HTTP and MCP (API worker)

Own src/cabinet/store.js, src/cabinet/router.js, src/mcp/cabinet-server.js, db/migrations/032_cabinet_one_off_launch.sql, new tests/cabinet-one-off.test.js, tests/mcp/cabinet-server.test.js, package.json test list if required. Coordinate exact four job field names with worker B.

- [ ] Write failing store/HTTP/MCP tests for the five review focus cases and successful 10+2 exact-date launch.
- [ ] Run RED with a disposable local cabinet_test database.
- [ ] Implement narrow prepare/execute, strict schemas and migration. Lock/re-read the connection before final snapshot validation. Include override metadata and all exact texts/times in preview. Reject rollover and outstanding jobs. Use existing actor-bound plan machinery and permissions.
- [ ] Run GREEN on new and existing cabinet/MCP suites; commit only owned implementation files.

## Task B: Dispatch enforcement (worker B)

Own deploy/telegram-connection/cabinet_worker.py and tests/cabinet_worker_test.py. Consume only four nullable job fields from task A; no API/schema edits.

- [ ] Write failing offline worker tests for ordinary cap, exact-day/window exception, current-base+2 clamp, expired cancellation, and no send after stop/identity/rate/uncertain checks.
- [ ] Run RED, implement minimal worker handling using DB job fields and existing delivery locking, then run GREEN. Never connect to Telegram in tests.
- [ ] Commit only the two owned files.

## Task C: Review, deploy and real approved plan (root)

- [ ] Independently review migration, snapshot/concurrency, scopes, exact day/window and worker expiration.
- [ ] Run full required checks and build; create/update a focused PR and deploy the exact tested commit through the established workflow.
- [ ] Read MCP capabilities, prepare only the two saved draft IDs using a remaining today window, show the complete returned plan and request fresh approval.
- [ ] Execute only approved unexpired plan; monitor the two exact jobs to confirmed sent or an actionable failure. Verify permanent campaign is 20/day with window 12:02–15:55, update monitoring instructions to the verified setting, and report actual results.
