# Cabinet conversion statistics implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Display automatic conversion metrics and let the existing agent maintain evidence-based conversation outcomes.

**Architecture:** Derive recipient cohorts from confirmed deliveries and imported messages. Keep semantic outcomes in an isolated table with snapshot/evidence checks; expose scoped HTTP/MCP operations and cabinet controls. Extend existing automation-3 rather than creating a second agent.

**Tech Stack:** PostgreSQL, Node/Express, existing MCP and vanilla cabinet UI.

**Spec:** ../specs/2026-11-28-cabinet-conversion-stats.md

## Global constraints

Unique recipients, Moscow first-delivery cohorts, late replies attributed back, no inferred bookings, no delivery/queue mutations, strict owner/campaign isolation. Preserve the current automation schedule and notification preferences.

## Review focus

- Multiple jobs/messages for one recipient must not inflate conversion.
- Midnight boundaries and replies arriving days later must preserve the original cohort.
- Stale or cross-tenant evidence must never update an outcome.
- Agent updates must not overwrite human decisions or affect delivery approvals.
- Empty, failed, uncertain and nontext-only cases must remain truthful and reviewable.

### Task 1: Metrics and scoped outcome storage

Files: new migration 034, src/cabinet/analytics.js, store.js/router.js integration, tests/cabinet-analytics.test.js.

- [x] Write and observe failing real-DB tests for all review-focus cases.
- [x] Implement campaignStats, conversationReviews and saveConversationOutcome, strict validation and scoped APIs.
- [x] Verify tests; commit.

### Task 2: MCP and cabinet UI

Files: src/mcp/cabinet-server.js, public/cabinet.{js,html,css}, MCP tests and docs.

- [x] Add scoped read/review/write tools and thread pagination; test schemas/denials.
- [x] Build dedicated Analytics dashboard with KPI cards, cohort columns, funnel, source bars, outcome donut, compact conversations table and manual corrections; inspect desktop/mobile renders.
- [x] Run complete checks and independent review; fix important findings; commit.

### Task 3: Deploy and agent update

- [ ] Deploy reviewed changes and verify production health and baseline arithmetic.
- [ ] Assess existing conversations through MCP and read back totals/reasons.
- [ ] Update automation-3, preserving existing fields and no-send constraints; read back saved instructions.
- [ ] Record evidence and report exact current conversions and update cadence.

## Validation evidence

Local checks on 28 November: npm run check passed; 100 real-DB cabinet/MCP tests passed; 53 worker tests passed. Browser boundary tests passed for pending-refresh pagination, campaign changes clearing private data, explicit correction evidence, preserving source filters with zero matches, and integer small-count chart axes. Actual local API preview verified 16 recipients, six respondents, four interested, source-filter totals of eight, and no horizontal page overflow at 390 px. Desktop/mobile screenshots inspected. Independent review fixes incorporated; no remaining material blockers reported.
