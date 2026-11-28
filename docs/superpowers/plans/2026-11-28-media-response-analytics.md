# Media archive and response analytics implementation plan

> Use superpowers:executing-plans and dispatching-parallel-agents for the independent modules; root owns integration and final review. No overlapping implementation ownership.

**Goal:** Persist scoped audio/video and expose configurable elapsed/working response analytics in cabinet and MCP.
**Architecture:** Two independent modules: response pairing/calendar/aggregates and durable media queue/worker. Root integrates private file API, cabinet players/speed dashboard, MCP and deployment.
**Tech stack:** Existing Node22/PostgreSQL/vanilla UI, pinned Telethon1.45 worker, private persistent disk.
**Spec:** ../specs/2026-11-28-media-response-analytics.md

## Global constraints

Only existing verified outreach recipients/messages, no arbitrary chats/history/sessions. No new sends or delivery-control changes. Manual follow-up dates stay manual. Moscow calendar is analytics-only. Keep tenant isolation, explicit timestamp provenance, accurate pending/anomaly metrics, metadata for failed media rather than false archive success. Private files never public assets. Preserve unrelated canonical edits.

## Tasks

- [x] A. Response backend, migration036 and dedicated tests (response worker owns only assigned files). Exact contract in ../briefs/2026-11-28-response-analytics.md.
- [x] B. Media archive helper, worker integration, migration037 and dedicated tests (media worker owns only assigned files). Exact contract in ../briefs/2026-11-28-media-archive.md.
- [x] C. Root integrates scoped file API/store/router and readonly MCP response/media tools, speed UI/calendar, players/timestamps; real-DB/HTTP/browser tests, regression suites and independent review.
- [ ] D. Deploy web/migrations, rebuild/restart only cabinet worker after in-flight checks; verify exact code, identity, heartbeat, scoped media discovery, MCP metrics, calendar defaults, existing conversions/manual follow-ups, no customer sends. Update existing agent prompt/workflow preserving schedule.

## Evidence / decisions

Existing server timestamps persisted. Initial50GBroot disk96% used/2.4GBfree; removed only unused build cache older24h, reclaimed739MB, now3.4GBfree. Existing data, images, volumes and backups untouched. Storage floor and visible backpressure are essential. Builder review completed, detailed rulings in spec.


## Pre-deployment evidence

Response module11tests, fresh fullcabinet117tests, Python53existing+23media tests, eight Chromium boundary tests allpassed. Actualowner-cookie preview proved calendarCAS save, elapsed vsworking recalculation, exact timestamps, private file-route ranges/denials and390pxresponsive layout. UIrender screenshots inspected. Independent response taskreview, media/file taskreview and wholebranch integrationreview allSPEC/QUALITY PASS with no material findings. ExactmetadatafiletimestampsincludedMCPmedia list. Prepared separatehostdirectory /var/lib/outreach-cabinet-media UID65532:GID1000 mode2750, sessionsremainseparate. No client test messages sent.
