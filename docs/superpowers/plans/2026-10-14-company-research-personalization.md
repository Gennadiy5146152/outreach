# Company Research Personalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an evidence-backed, agent-driven company research queue with general and confirmed-executive draft candidates, while keeping delivery behind the existing separate approval boundary.

**Architecture:** PostgreSQL stores company research runs, bounded evidence, contacts, facts, and non-sendable draft candidates. The existing API exposes queue/review operations, and MCP provides a leased research-job protocol plus prepare/execute gates for high-impact batches. The current Personalization UI renders the research cards.

**Tech Stack:** Node.js ESM, Express, PostgreSQL, MCP SDK, Zod, vanilla browser JavaScript, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-14-company-research-personalization-design.md`

## Global Constraints

- Research all otherwise eligible companies; priority changes ordering only.
- Store at most ten public sources per company and excerpts no longer than 500 characters.
- Never guess an email and never confirm a contact without a stored source.
- Research and candidate generation cannot enqueue or send mail.
- Queue creation and candidate materialization require prepare/execute confirmation.
- Preserve all existing suppression, quota, reply-stop, and company-stop behavior.

## Review Focus

- Concurrent claims: only one unexpired claimant may mutate a run.
- Duplicate company/contact inputs: retries must not create parallel runs or candidates.
- Malicious source input: unsafe URLs, oversized excerpts, and source eleven must fail closed.
- Weak contact evidence: name-only and guessed email candidates must never become confirmed recipients.
- Delivery boundary: research operations must not touch queue, enrollment, message, or mail paths.

---

### Task 1: Persistence and research domain

**Files:**
- Create: `db/migrations/016_company_research.sql`
- Create: `src/services/company-research.js`
- Test: `tests/company-research.test.js`
- Test: `tests/company-research-store.test.js`

**Interfaces:**
- Produces: priority/key helpers, input validation, queue/claim/evidence/completion repository functions, and migration-backed entities.

- [ ] Write failing tests for priority-without-exclusion, company dedupe keys, safe bounded sources, evidence-linked facts/contacts, leases, and candidate dedupe.
- [ ] Run the new tests and verify missing module/migration behavior fails.
- [ ] Add migration and minimal domain/store implementation.
- [ ] Run the new tests and verify they pass.

### Task 2: HTTP API and protected MCP workflow

**Files:**
- Create: `src/services/company-research-api.js`
- Modify: `src/server.js`
- Modify: `src/mcp/tool-definitions.js`
- Modify: `src/mcp/tool-handlers.js`
- Test: `tests/company-research-api.test.js`
- Modify: `tests/mcp/tool-handlers.test.js`
- Modify: `tests/mcp/protected-tools.test.js`

**Interfaces:**
- Consumes: Task 1 repository functions.
- Produces: research list/detail/claim/evidence/complete routes and MCP tools; protected queue/draft prepare/execute snapshots.

- [ ] Write failing API/MCP tests for the route/tool contract, confirmation freshness, lease ownership, bounded payloads, and absence of delivery mutations.
- [ ] Run the focused tests and verify expected failures.
- [ ] Implement API routes, schemas, handlers, and confirmation snapshots.
- [ ] Run focused tests and verify they pass.

### Task 3: Research review UI

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `tests/test-personalization-ui-static.js`

**Interfaces:**
- Consumes: Task 2 list/detail/queue API.
- Produces: safe research dashboard and company cards inside Personalization.

- [ ] Add failing static UI assertions for queue controls, state filters, evidence/contact/candidate rendering, and escaping.
- [ ] Run the UI test and verify it fails on the missing elements.
- [ ] Implement the research panel, renderers, controls, and styles without raw source HTML.
- [ ] Run the UI test and verify it passes.

### Task 4: Integration, documentation, and deployment readiness

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: deployment files only if required by verification.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: complete validation command and operator/MCP documentation.

- [ ] Add new tests to `npm run check` and document the research workflow and three approval boundaries.
- [ ] Run syntax checks, focused tests, migration static tests, and the full `npm run check` suite.
- [ ] Review the complete diff for sending-path isolation, secrets, and migration safety.
- [ ] Commit the implementation; push and deploy only under the user's already stated deployment instruction, then verify health and research API without starting delivery.

