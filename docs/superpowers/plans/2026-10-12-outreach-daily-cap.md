# Outreach Daily Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce one configurable daily total for first-touch and follow-up outreach messages while prioritizing due follow-ups.

**Architecture:** Add the global limit to persisted runtime settings and expose it through the existing API/UI/MCP paths. Centralize quota arithmetic in a pure service, then make the worker serialize queue claims, count sent and running outreach within the application-time-zone day, apply global/mailbox/campaign caps, and order follow-ups first.

**Tech Stack:** Node.js ESM, Express, PostgreSQL, vanilla browser JavaScript, Node test runner/static integration checks.

**Spec:** `docs/superpowers/specs/2026-10-12-outreach-daily-cap-design.md`

## Global Constraints

- Default global outreach limit is exactly `100` messages per application-time-zone day.
- First-touch and follow-up outreach share the same limit across every mailbox and campaign.
- Warmup and test messages do not consume the outreach limit.
- Follow-ups have priority; first-touch fills only remaining capacity.
- Worker activation remains a separately approved operational action.

## Review Focus

- Two workers claim concurrently: running reservations must prevent oversubscription.
- Midnight in a non-UTC application time zone: usage resets on the configured local date.
- A failed/retried send: a released `running` reservation must not permanently consume quota.
- Null mailbox or campaign limits: only the global cap applies.
- Runtime settings saved by delivery-mode MCP: the current daily cap must not be reset.

---

### Task 1: Runtime setting and controls

**Files:**
- Modify: `src/services/runtime.js`
- Modify: `src/server.js`
- Modify: `public/app.js`
- Modify: `src/mcp/tool-handlers.js`
- Create: `tests/test-outreach-daily-limit-settings.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `getRuntimeSettings().outreachDailyLimit: number` and persisted `saveRuntimeSettings({ outreachDailyLimit })`.
- Consumes: existing runtime settings API and form payload conventions.

- [ ] **Step 1: Write failing behavioral/static integration tests** for default `100`, validation range, API/UI exposure, and MCP payload preservation.
- [ ] **Step 2: Run `node tests/test-outreach-daily-limit-settings.js` and verify the missing-setting assertions fail.**
- [ ] **Step 3: Implement runtime normalization, API validation/response fields, UI input, and MCP preservation.**
- [ ] **Step 4: Run `node tests/test-outreach-daily-limit-settings.js` and verify it passes.**
- [ ] **Step 5: Commit runtime setting support.**

### Task 2: Concurrency-safe worker enforcement

**Files:**
- Create: `src/services/outreach-quota.js`
- Modify: `src/worker/index.js`
- Create: `tests/outreach-quota.test.js`
- Create: `tests/test-outreach-daily-limit-worker.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `getRuntimeSettings().outreachDailyLimit` from Task 1.
- Produces: `quotaRemaining({ globalLimit, globalUsed, mailboxLimit, mailboxUsed, campaignLimit, campaignUsed })` and worker claim behavior.

- [ ] **Step 1: Write failing unit tests** for global, mailbox, campaign, and released-reservation arithmetic.
- [ ] **Step 2: Run `node --test tests/outreach-quota.test.js` and verify missing-module/behavior failure.**
- [ ] **Step 3: Implement the pure quota service.**
- [ ] **Step 4: Run the quota unit test and verify it passes.**
- [ ] **Step 5: Write a failing worker integration/static test** requiring advisory locking, time-zone day bounds, sent plus running accounting, and follow-up priority.
- [ ] **Step 6: Run `node tests/test-outreach-daily-limit-worker.js` and verify it fails.**
- [ ] **Step 7: Modify `lockNextSend()` to enforce caps transactionally and prioritize follow-ups.**
- [ ] **Step 8: Run both new worker tests and verify they pass.**
- [ ] **Step 9: Commit worker enforcement.**

### Task 3: Documentation and full verification

**Files:**
- Modify: `README.md`
- Modify: `deploy/README.md`

**Interfaces:**
- Consumes: setting and worker behavior from Tasks 1–2.
- Produces: operator instructions describing the 100-message aggregate cap and stopped-worker safety.

- [ ] **Step 1: Document aggregate counting, follow-up priority, time-zone reset, and worker activation safety.**
- [ ] **Step 2: Run `npm run check` and verify the entire suite passes.**
- [ ] **Step 3: Commit documentation and verification updates.**
