# Cabinet MCP campaigns implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create paused private campaigns through authorized cabinet-wide draft tokens and import Artem's reviewed messages.
**Architecture:** Extend the existing cabinet store/API and bounded private MCP catalog. Reuse ownership, schedule and transaction checks; add a minimal read endpoint for sender selection.
**Tech Stack:** Existing Node.js/Express/PostgreSQL and MCP SDK.
**Spec:** docs/superpowers/specs/2026-11-25-cabinet-mcp-campaigns.md

## Global constraints
- Require `outreach:draft` and `all_campaigns=true`; never accept caller-supplied owner identity.
- Preserve owner-only connections/QR/auth and prepare/approval/execute for delivery.
- No production test data, production DB test cleanup or automatic sending.

## Review focus
- Selected-campaign/read/send-only/revoked tokens must remain denied.
- Foreign connections and forged owner fields must never create a cross-cabinet campaign.
- Listing only safe sender-selection fields must not expose QR or Telegram session data.
- Schedule conflicts/invalid windows and draft import duplicates must be rejected.
- Empty campaign creation must leave paused=true and create zero jobs.

## Tasks
- [ ] Add failing PostgreSQL+HTTP coverage in tests/cabinet.test.js for all access cases, safe fields, validation and zero jobs. Add MCP catalog/schema coverage in tests/mcp/cabinet-server.test.js. Run red.
- [ ] Add guarded campaignConnections and campaign creation access in src/cabinet/store.js, GET /campaign-connections in router.js, bounded tools in cabinet-server.js and allCampaigns context in server.js. Run green.
- [ ] Update docs/private-cabinets.md, run repository checks, real disposable-DB cabinet and worker suites, review patch and commit only owned files.
- [ ] Deploy the tested revision through the existing deployment workflow, preserving unrelated local edits. Verify MCP with Artem's saved token, create paused campaign, import reviewed334 sequentially with resumable IDs, read back exact bodies/identity/order and empty queue. Save receipts.
