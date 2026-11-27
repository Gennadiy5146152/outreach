# Ordinary cabinet replies implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Record ordinary recipient replies and recover the approved 14 conversations from 27 November.

**Architecture:** Extend the worker's correlation to known sent recipients while preserving explicit-thread validation. Add a server-only bounded recovery command that holds the existing connection lock and uses the same recorder. Reuse cabinet_messages and scoped MCP reads.

**Tech Stack:** Python, Telethon, psycopg/PostgreSQL, existing Node MCP.

**Spec:** ../specs/2026-11-27-cabinet-plain-replies.md

## Global constraints

No delivery, no session export, no unrelated dialogs, no read receipts, no migration. Recover only the explicit 14 sent jobs during the approved day.

## Review focus

- Missing reply header must not discard an ordinary response.
- An unknown explicit parent must not be reassigned.
- Outgoing delivery events must not race or steal delivery receipts.
- History pagination must not silently truncate or exceed the approved peer/time bounds.
- Locks, owner identity and generation must protect recovery and concurrent live ingestion.

### Task 1: Recorder and bounded recovery

Files: deploy/telegram-connection/cabinet_worker.py, deploy/telegram-connection/recover_replies.py, deploy/telegram-connection/Dockerfile, tests/cabinet_worker_test.py.

- [x] Add regressions for the review focus plus real database isolation and duplicate events; run and observe expected failures.
- [x] Implement ordinary/explicit matching, scoped outbound continuation and recovery RPC validation/pagination.
- [x] Run worker tests, cabinet/MCP tests and npm run check; commit.

### Task 2: Deploy and recover

Files: docs/private-cabinets.md, src/mcp/cabinet-server.js and deployment evidence.

- [x] Document scoped conversation semantics and maintenance command; review complete diff independently.
- [x] Deploy reviewed worker and descriptions; verify actual running hash and health.
- [x] Hold connection lock and restore exact 14 approved job threads for today's bounded time range.
- [x] Verify through MCP and report actual replies with remaining limitations.

Validation: 53 worker tests passed against disposable PostgreSQL, including real pinned Telethon history pagination with fake RPCs; 89 cabinet/MCP tests passed, npm run check passed. Independent review found short-page truncation, problematic wire min_id, and maintenance update-cursor loss. Recovery now uses Telethon's bounded chronological iterator; a real SQLiteSession regression confirms maintenance cannot overwrite live update state. A send/ingestion lock plus sequential update dispatch and attempted-at timestamp regression covers replies arriving before the RPC receipt.

Production completion, 27 November 17:36 MSK: PR #8 merged as `9dead19bbc019a6ec56031709e7390e5eec22530`; CI run 46016927209 passed. Actual running cabinet worker SHA-256 `2baaeeb4b0143429362058ebf98dd691181529388165177594c9f3f7cbfa7fd7` verified. Bounded recovery of the approved 14 sent jobs completed: 31 messages imported, comprising 17 inbound messages and 14 manual outbound continuation messages in four recipient threads. Read-back through the owner's scoped MCP confirms all four conversations. Worker restarted, Artem connected, web health OK, no new outreach deliveries created. Private transcripts are in the existing ignored MSKWRAPCAR storage directory, not committed.
