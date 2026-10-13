# Lead Personalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a safe website-enrichment pipeline that qualifies leads and creates 30 evidence-backed personalized outreach drafts without enrolling, queueing, or sending them.

**Architecture:** A dedicated personalization worker claims only enrichment and draft-generation jobs; it cannot call mail delivery code. The web API creates and monitors pilots, existing outreach draft tables hold the generated messages, and every personalized fact is stored with page evidence. UI and MCP surfaces expose preview, confirmed pilot creation, progress, evidence, and drafts.

**Tech Stack:** Node.js 22 ESM, Express, PostgreSQL 16, native `fetch`, `node:dns/promises`, Yandex GPT, existing vanilla JS UI, MCP SDK, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-13-lead-personalization-design.md`

## Global Constraints

- The first pilot contains exactly 30 selected leads unless fewer eligible leads exist.
- A generated first message is 500–700 characters; its follow-up contains 2–3 sentences.
- Every personalized fact has a source URL and evidence excerpt.
- A contact name is used only when the existing lead data or a page explicitly confirms it with high confidence; a name parsed only from an email local part remains an unconfirmed candidate.
- Alternative contacts never replace `leads.email` automatically.
- Personalization creates no `enrollments`, `sending_queue`, or `messages` rows.
- Existing manually edited drafts are never overwritten.
- Sending generated drafts still requires the existing explicit launch and queue approvals.
- Website access is limited to HTTP/HTTPS public destinations, three same-site pages, bounded redirects, bounded response size, and a request timeout.
- No random synonym replacement is used to evade provider filters.

## Review Focus

- URLs that resolve or redirect to loopback, private, link-local, or metadata IPs must be rejected before and after every redirect (Task 2 tests).
- A model response that cites an absent fact, invents a name, or exceeds message limits must be blocked, not partially saved as ready (Task 3 tests).
- Retrying a completed job or the same pilot must not duplicate enrichment records, imports, drafts, or draft steps (Task 4 tests).
- Manual edits made after generation must survive retries and regeneration attempts (Tasks 4 and 5 tests).
- Starting or running a personalization pilot must leave enrollment, delivery queue, and message counts unchanged (Tasks 4 and 8 tests).

---

### Task 1: Persistence Model for Pilots and Evidence

**Files:**
- Create: `db/migrations/015_lead_personalization.sql`
- Create: `src/services/personalization-store.js`
- Create: `tests/lead-personalization-store.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `createPilot(client, { limit, rulesVersion, leadIds }) -> pilot`
- Produces: `upsertEnrichment(client, enrichment) -> row`
- Produces: `getPilot(client, pilotId) -> { pilot, items }`
- Produces: `createDraftFromPersonalization(client, input) -> { draftId, created }`

- [ ] **Step 1: Write failing migration and store tests**

Assert that the migration creates `personalization_pilots`, `personalization_pilot_items`, and `lead_enrichments`; adds a nullable unique `lead_enrichment_id` and `manually_edited_at` to `outreach_drafts`; and that store helpers use transactions and conflict-safe writes.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `node --test tests/lead-personalization-store.test.js`

Expected: FAIL because the migration and store module do not exist.

- [ ] **Step 3: Add the forward-compatible migration**

Define pilot statuses `draft|running|completed|completed_with_errors|cancelled`, item statuses `pending|enriching|qualified|review|excluded|generating|ready|failed`, and enrichment statuses `qualified|review|excluded|failed`. Add unique constraints on `(lead_id, rules_version)`, `(pilot_id, lead_id)`, and `outreach_drafts.lead_enrichment_id`.

- [ ] **Step 4: Implement the store interfaces**

Keep SQL and idempotency rules in `src/services/personalization-store.js`. `createDraftFromPersonalization` must create a synthetic `outreach_imports` row per pilot, one `outreach_drafts` row, and exactly two `outreach_draft_steps` in one transaction; return the existing draft when the enrichment was already materialized.

- [ ] **Step 5: Run focused and migration checks**

Run: `node --test tests/lead-personalization-store.test.js && node src/db/migrate.js`

Expected: tests PASS and migration exits 0 against the development database.

- [ ] **Step 6: Add the focused test to `npm run check` and commit**

```bash
git add db/migrations/015_lead_personalization.sql src/services/personalization-store.js tests/lead-personalization-store.test.js package.json
git commit -m "feat: add lead personalization persistence"
```

### Task 2: Safe Website Reader and Signal Extraction

**Files:**
- Create: `src/services/website-enrichment.js`
- Create: `tests/website-enrichment.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `normalizeWebsiteUrl(value) -> URL`
- Produces: `assertPublicHttpUrl(url, { lookup }) -> Promise<void>`
- Produces: `fetchWebsitePages({ website, fetchImpl, lookup, timeoutMs, maxBytes }) -> Promise<{ pages, errors }>`
- Produces: `extractSiteSignals(pages) -> { canonicalCompany, businessType, city, namedContacts, alternativeEmails, digitalProcesses }`

- [ ] **Step 1: Write failing URL-safety tests**

Cover public HTTPS, credentials in URLs, non-HTTP schemes, IPv4/IPv6 loopback, RFC1918, link-local, carrier-grade NAT, cloud metadata destinations, DNS answers containing any private address, and a public URL that redirects to a private address.

- [ ] **Step 2: Write failing page-boundary tests**

Assert a maximum of three same-site pages, five redirects, a 10-second timeout, a 1 MiB response limit per page, HTML-only parsing, and graceful partial results when a secondary page fails.

- [ ] **Step 3: Write failing extraction tests**

Use fixed HTML fixtures to verify canonical company name, contacts with role evidence, alternative email deduplication, and digital-process evidence for forms, ecommerce, booking, online appointments, catalogues, and personal accounts.

- [ ] **Step 4: Implement native-fetch website reading**

Use manual redirects, `node:dns/promises`, `node:net`, abort signals, streamed byte limits, same-registrable-host checks, and conservative text/link extraction. Do not execute scripts or load subresources.

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/website-enrichment.test.js`

Expected: PASS with no network access because all fetch and DNS behavior is injected.

- [ ] **Step 6: Add the focused test to `npm run check` and commit**

```bash
git add src/services/website-enrichment.js tests/website-enrichment.test.js package.json
git commit -m "feat: add safe website enrichment"
```

### Task 3: Qualification and Evidence-Bound Copy Generation

**Files:**
- Create: `src/services/lead-personalization.js`
- Create: `tests/lead-personalization.test.js`
- Modify: `src/services/yandex-gpt.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `extractSiteSignals(pages)` output from Task 2.
- Produces: `qualifyLead({ lead, signals }) -> { status, score, reason, fact }`
- Produces: `confirmedContact({ lead, signals }) -> { name, position, confidence } | null`
- Produces: `generatePersonalizedCopy({ lead, enrichment, callModel }) -> Promise<{ subject, bodyText, followupSubject, followupBodyText, usedEvidence }>`
- Produces: `validatePersonalizedCopy(copy, enrichment) -> { ok, errors }`

- [ ] **Step 1: Write failing qualification tests**

Cover positive digital-process signals, federal branches, banks, government bodies, empty informational pages, ambiguous small businesses, unavailable sites, and deterministic reasons for `qualified`, `review`, `excluded`, and `failed`.

- [ ] **Step 2: Write failing identity-policy tests**

Prove that an existing confirmed lead name or a page containing a named employee and role can produce a greeting. A clear personal mailbox such as `ivan.petrov@…` may produce a medium-confidence candidate for review but cannot produce a greeting without corroboration; `info@`, numeric aliases, and ambiguous mailbox-local-part names produce no name candidate.

- [ ] **Step 3: Write failing model-boundary tests**

Assert strict JSON parsing, 500–700 characters for the first message, 2–3 follow-up sentences, one closing question, allowed evidence IDs only, no unknown names, no unresolved markers, and rejection of unsupported claims.

- [ ] **Step 4: Implement deterministic qualification and prompting**

Use explicit scoring rules before the model. Give Yandex GPT only confirmed fields and evidence IDs; request strict JSON and validate it after generation. Extend the mock response path in `src/services/yandex-gpt.js` for deterministic tests.

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/lead-personalization.test.js`

Expected: PASS for all qualification, identity, and hallucination guards.

- [ ] **Step 6: Add the focused test to `npm run check` and commit**

```bash
git add src/services/lead-personalization.js src/services/yandex-gpt.js tests/lead-personalization.test.js package.json
git commit -m "feat: qualify leads and generate grounded copy"
```

### Task 4: Isolated Personalization Worker

**Files:**
- Create: `src/personalizer/index.js`
- Create: `src/services/job-queue.js`
- Create: `tests/personalization-worker.test.js`
- Modify: `src/worker/index.js`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.prod.yml`
- Modify: `deploy/outreach-deploy.sh`
- Modify: `deploy/README.md`
- Modify: `tests/deploy-script.test.js`
- Modify: `tests/deploy-compose.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 store functions and Task 2–3 enrichment functions.
- Produces: `claimJob(client, { jobTypes }) -> job | null`
- Produces: personalizer handlers for `enrich_lead` and `generate_personalized_draft` only.

- [ ] **Step 1: Write failing job-isolation tests**

Assert the delivery worker claims only `validate_lead|sync_inbox|warmup_send`, the personalizer claims only `enrich_lead|generate_personalized_draft`, and `src/personalizer/index.js` neither imports `sendMail` nor mutates `sending_queue`, `enrollments`, or `messages`.

- [ ] **Step 2: Write failing idempotency and manual-edit tests**

With a fake database client, run each handler twice and assert one enrichment, one draft, two steps, preserved `manually_edited_at` content, and final pilot counters derived from item states.

- [ ] **Step 3: Extract bounded job claiming and update the delivery worker**

Move claim/finish/fail primitives to `src/services/job-queue.js`. Require every caller to pass an allowlist; do not support an unfiltered claim mode.

- [ ] **Step 4: Implement the personalizer process**

On `enrich_lead`, read the lead, fetch pages, persist evidence and qualification, then enqueue generation only for `qualified`. On `generate_personalized_draft`, generate and validate copy, persist the draft transactionally, and update the pilot item. Log failures without exposing page contents or secrets.

- [ ] **Step 5: Add and deploy the isolated service**

Add a `personalizer` Compose service with no worker profile and command `node src/personalizer/index.js`. Update guarded deployment to restart `web` and `personalizer`; keep the mail-capable `worker` under its existing separate approval profile.

- [ ] **Step 6: Run worker and deployment tests**

Run: `node --test tests/personalization-worker.test.js tests/deploy-compose.test.js tests/deploy-script.test.js`

Expected: PASS, including proof that automatic deployment still does not start or restart the mail worker.

- [ ] **Step 7: Add focused tests to `npm run check` and commit**

```bash
git add src/personalizer/index.js src/services/job-queue.js src/worker/index.js docker-compose.yml docker-compose.prod.yml deploy/outreach-deploy.sh deploy/README.md tests/personalization-worker.test.js tests/deploy-script.test.js tests/deploy-compose.test.js package.json
git commit -m "feat: isolate personalization processing"
```

### Task 5: Pilot API and Manual-Edit Protection

**Files:**
- Create: `src/services/personalization-api.js`
- Create: `tests/personalization-api.test.js`
- Modify: `src/server.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 store functions.
- Produces: `GET /api/personalization/pilots`
- Produces: `GET /api/personalization/pilots/:id`
- Produces: `POST /api/personalization/pilots/preview`
- Produces: `POST /api/personalization/pilots`
- Produces: `POST /api/personalization/pilots/:id/retry`
- Produces: `PATCH /api/personalization/items/:id`

- [ ] **Step 1: Write failing selection-preview tests**

Assert that preview selects at most 30 diverse valid/risky, unsuppressed leads with websites; excludes previous backup outreach recipients and active conversations; and returns counts plus reasons without writing jobs or drafts.

- [ ] **Step 2: Write failing pilot-start tests**

Assert that start snapshots the previewed lead IDs, creates exactly one item and `enrich_lead` job per lead, rejects stale preview tokens, and returns the pilot ID without touching delivery tables.

- [ ] **Step 3: Write failing review and edit tests**

Assert detail responses include evidence URLs/excerpts and draft previews; overriding `review|excluded|qualified` records who changed it; editing an existing draft sets `manually_edited_at`; retries cannot replace manually edited text.

- [ ] **Step 4: Implement the API service and routes**

Keep selection SQL and state transitions in `src/services/personalization-api.js`; keep Express handlers thin. Use a deterministic preview token derived from selected lead IDs and current enrichment versions.

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/personalization-api.test.js`

Expected: PASS and explicit assertions of zero delivery-table writes.

- [ ] **Step 6: Add the focused test to `npm run check` and commit**

```bash
git add src/services/personalization-api.js src/server.js tests/personalization-api.test.js package.json
git commit -m "feat: add personalization pilot API"
```

### Task 6: Personalization Review UI

**Files:**
- Create: `tests/test-personalization-ui-static.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 5 HTTP endpoints.
- Produces: a `Персонализация` view with preview, pilot progress, evidence, qualification controls, and draft links.

- [ ] **Step 1: Write a failing static UI contract test**

Require navigation, a preview summary, an explicit “Подготовить 30 черновиков” action, status filters, source links, evidence excerpts, fit reasons, contact confidence, retry action, and links to existing draft editing.

- [ ] **Step 2: Implement state loading and rendering**

Add `personalizationPilots`, selected pilot, filters, pagination, and safe escaped rendering. Open evidence links with `rel="noopener noreferrer"`; never render fetched HTML.

- [ ] **Step 3: Implement pilot preview and start confirmation**

Preview must show exact selected count and exclusion summary. Starting the pilot requires a browser confirmation but does not use or imply sending approval.

- [ ] **Step 4: Implement review controls**

Allow filtering `qualified|review|excluded|failed|ready`, manual status override, retry, and navigation to the existing draft drawer while preserving manual-edit state.

- [ ] **Step 5: Run UI checks**

Run: `node tests/test-personalization-ui-static.js && node --check public/app.js`

Expected: PASS.

- [ ] **Step 6: Add the test to `npm run check` and commit**

```bash
git add public/index.html public/app.js public/styles.css tests/test-personalization-ui-static.js package.json
git commit -m "feat: add personalization review UI"
```

### Task 7: MCP Control for Personalization Pilots

**Files:**
- Modify: `src/mcp/tool-definitions.js`
- Modify: `src/mcp/tool-handlers.js`
- Modify: `tests/mcp/tool-handlers.test.js`
- Modify: `tests/mcp/protected-tools.test.js`
- Modify: `tests/mcp/server-integration.test.js`

**Interfaces:**
- Consumes: Task 5 HTTP endpoints.
- Produces: `personalization_pilots_list` read tool.
- Produces: `personalization_pilot_get` read tool.
- Produces: `personalization_pilot_prepare` prepare tool with `{ limit: 1..30 }`.
- Produces: `personalization_pilot_execute` execute tool requiring a current confirmation token and `confirm: true`.

- [ ] **Step 1: Extend failing MCP catalog and routing tests**

Assert bounded schemas, page-size caps, exact API paths, redaction of page evidence beyond the allowed excerpt, and execute protection.

- [ ] **Step 2: Implement read handlers**

Map list/detail tools to the API and return concise summaries with candidate, ready, review, excluded, and failed counts.

- [ ] **Step 3: Implement prepare/execute confirmation flow**

Prepare calls the preview endpoint and stores the exact lead-ID snapshot/token. Execute accepts only the matching unexpired confirmation and calls pilot creation once.

- [ ] **Step 4: Run MCP tests**

Run: `npm run test:mcp`

Expected: all MCP tests PASS; execute without prior current approval is rejected.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tool-definitions.js src/mcp/tool-handlers.js tests/mcp/tool-handlers.test.js tests/mcp/protected-tools.test.js tests/mcp/server-integration.test.js
git commit -m "feat: expose personalization through MCP"
```

### Task 8: Full Verification, Production Deployment, and 30-Draft Pilot

**Files:**
- Modify if needed: `README.md`
- Modify if needed: `.env.example`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: a deployed pilot of 30 reviewable drafts and a verification report.

- [ ] **Step 1: Run the complete local verification suite**

Run: `npm run check`

Expected: exit 0 with every unit, static, MCP, deployment, and regression test passing.

- [ ] **Step 2: Verify the branch diff and safety invariants**

Run: `git diff --check HEAD~7..HEAD` and inspect that the personalizer has no imports from `mail.js` and no writes to `sending_queue`, `enrollments`, or `messages`.

- [ ] **Step 3: Push the reviewed commits to `main` and observe automatic deployment**

Use the existing GitHub workflow. Verify exact deployed SHA, successful migrations, healthy `web`, healthy `personalizer`, and unchanged mail-worker lifecycle.

- [ ] **Step 4: Prepare the exact 30-lead pilot through MCP or UI**

Review selected count, city/segment diversity, exclusions, and expected Yandex GPT workload. Obtain explicit approval for the pilot mutation, then execute it. This approval does not authorize email delivery.

- [ ] **Step 5: Wait for personalization completion and verify data**

Query pilot/item counts and assert 30 terminal items; inspect all ready drafts for evidence, length, greeting policy, and follow-up length. Record excluded, review, failed, and ready totals.

- [ ] **Step 6: Prove there was no delivery side effect**

Compare before/after counts for `enrollments`, `sending_queue`, and `messages` for all pilot lead IDs. Expected deltas: `0`, `0`, `0`.

- [ ] **Step 7: Present the 30 drafts for human review**

Provide a compact table with company, email, qualification reason, evidence link, greeting, subject, first-message preview, follow-up, and status. Do not launch or approve any delivery action.

- [ ] **Step 8: Commit documentation adjustments if any**

```bash
git add README.md .env.example
git commit -m "docs: document personalization pilot operations"
```
