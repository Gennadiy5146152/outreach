# Source Recipient Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans and TDD. Preserve other workers' changes and commit only owned files.

**Goal:** Enable human-approved private-cabinet sends to exact public-group authors without usernames.

**Architecture:** Immutable recipient_source JSONB is copied from draft to job and approval previews. The worker resolves and verifies the exact source, then uses InputPeerUserFromMessage. Ordinary username recipients retain their path.

**Tech Stack:** Existing Node22, PostgreSQL16 and Telethon1.45/Python3.12.

**Spec:** docs/superpowers/specs/2026-11-27-source-recipient-design.md. User explicitly requested this capability; routine implementation choices follow the stated design without another permission gate.

## Global constraints

- No new recipient sends without fresh exact MCP prepare and human approval.
- No joins, contacts/participants/history/search, private groups, arbitrary hash import/export or peer fallback.
- Exact nullable recipient_source object: {chat_id:string positive raw channel ID <=9223372036854775807, username:normalized public group, message_id:int1..2147483647}.
- Fail malformed non-null sources; preserve existing identity/owner/pause/stop/quota/window/spacing/random_id/uncertain policies.
- No production actions in tests; no rollout until the two current jobs finish.

## Review focus

1. A reassigned group username, edited/deleted post, forward, anonymous sender or bot must never redirect delivery.
2. Source metadata cannot change through draft update, queue edit, or a stale plan; cross-mode recipients still deduplicate by numeric ID.
3. Every launch path copies the complete source; neither syntactic preview nor mutable research source_url is treated as verified author proof.
4. Expiry/stop/rate limits during proof produce zero SendMessageRequest calls and no false attempt/uncertain record.
5. Ordinary username sends remain compatible; schema rollout cannot strand existing sender connections.

## Task A: store, schema, HTTP and MCP (API worker)

Own src/cabinet/store.js, src/cabinet/router.js, src/mcp/cabinet-server.js, db/migrations/033_cabinet_source_recipients.sql, tests/cabinet-source.test.js, tests/mcp/cabinet-server.test.js and package.json test list. Other existing cabinet test fixtures only if required and announced.

- [ ] RED: strict source/address XOR, bigint/string bounds, source immutability and DB JSON constraints.
- [ ] Implement creation, read projections, both job inserts and full previews; queue-edit source equality and snapshot binding. Keep source_url separate.
- [ ] GREEN: actual disposable cabinet_test DB, full cabinet/MCP suites, check; commit only owned files.

## Task B: dispatch proof (worker)

Own deploy/telegram-connection/cabinet_worker.py and tests/cabinet_worker_test.py. Consume job.recipient_source as the exact object above; null retains username behavior.

- [ ] RED: successful three-RPC source send and each group/message/user/type mismatch, missing/private source, FloodWait on each proof RPC, expiry/stop during proof, malformed non-null source.
- [ ] Implement bounded fresh source resolution, no fallback, distinct pre-attempt source errors, post-await eligibility/window recheck, existing durable SendMessageRequest behavior.
- [ ] GREEN: offline worker suite against separate cabinet_test_verify database with no skips and zero live Telegram calls; commit only owned files.

## Task C: integration and production (root)

- [ ] Independently review all invariants; finish current two sends and save actual message IDs.
- [ ] Ensure existing read-only cabinet displays show personal ID/source honestly; document MCP source creation and rollout order.
- [ ] Run required checks/CI, focused PR and production rollout with pre-migration idle-worker stop; verify new worker source hash and sender heartbeat.
- [ ] Verify new tools/schema available through the real owner token without creating or sending new unapproved messages. Report actual supported behavior and remaining recipient qualification separately.
