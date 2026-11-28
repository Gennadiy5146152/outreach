# Response analytics backend report — 2026-11-28

Implemented only the assigned module, migration036, dedicated tests and this requested report. No commits, deployment, Telegram/network sends, or delivery changes.

## API

`createResponseAnalytics({query,campaign,ownerTransaction,now=()=>new Date()})` exports:

- `responseAnalytics(p,id,input={})`: strict optional ISO `from`/`to`, normalized `group_username`, `mode` elapsed/working, `side` artem/client, `status` all/answered/pending/anomaly, positive integer `page`, `page_size`1–100. Unknown keys, null/empty dates or source, numeric strings and malformed values fail `response_filters_invalid`. HTTP integrator converts valid page strings before calling the module.
- `responseSchedule(p,id)`: read-scoped campaign calendar, default Moscow Mon–Fri09:00–18:00 revision0 and updated_at null.
- `saveResponseSchedule(p,id,{weekdays,start,end,expected_revision})`: owner-session only, strict sorted unique ISO weekdays1–7 and one opening-before-closing HH:MM window. Live authentication delegated to real `ownerTransaction`; campaign ownership verified inside transaction. Campaign-specific advisory lock covers absent-row creation; expected revision CAS returns `response_schedule_changed`409 on stale/concurrent writes. Invalid input returns `response_schedule_invalid`. No campaign/window/limit/pause/jobs updates.

Optional pure exports: `workingSeconds(start,end,schedule)` and `buildResponseEpisodes(verifiedRows,{schedule,as_of})`.

Response shape follows the brief. Both-side summaries remain independent; day/group breakdowns reflect selected side. Status and pagination only affect episode items. Pending values are age, excluded from median/p90; anomalies have null durations and remain explicitly retrievable. P90 is nearest rank. Sorting is pending first, descending selected duration, stable episode ID.

Episodes combine verified sent jobs across campaign/connection/recipient in Telegram-ID order before date/source filtering. First service anchor sets conversation attribution and `job_id`; all verified jobs appear in `job_ids`. Source-mode public URL is reconstructed from immutable first-job recipient_source. `message_count` counts inbound messages (Artem burst size; client1 answered/0 pending), as agreed with root. Start/end provenance is returned without relabeling historical receipts. One injected `now()` establishes the report's common `as_of`.

## Migration036

Creates `cabinet_response_schedules` with owner/campaign composite foreign key, canonical weekday/window validation, timezone fixed Europe/Moscow, positive revision and timestamp.

Adds non-null `cabinet_messages.timestamp_source` with default telegram and telegram/service_receipt check. Existing matching outbound service anchors are marked service_receipt; sent_at is unchanged. The file was written atomically. Initial036 applied through `npm run migrate` on isolated local `cabinet_test_response`; subsequent defensive array-shape refinement was independently executed in a rolled-back temporary-schema migration test. Migration037 was subsequently applied through the normal migration runner to that same disposable DB when parent thread integration began requiring media columns.

## Verification

TDD RED observed before migration (missing persisted provenance), before module implementation (missing functions), and for strict null/empty validation, canonical first source URL, and multidimensional schedule rejection; corresponding GREEN runs followed.

Latest targeted command: `CABINET_TEST_DATABASE_URL=<isolated-local-cabinet_test_response> node --test tests/cabinet-response-analytics.test.js`: **11 pass,0 fail,0 skip**. `node --check src/cabinet/response-analytics.js`: passed.

Coverage includes exact opening/closing, overnight/weekend boundaries, zero outside working hours, custom weekday, fractional seconds and bounded400-year interval; first-inbound bursts spanning multiple jobs; initial client reply; pending/answered denominators; negative/invalid/future-pending anomalies; date filtering after pairing; source filters and immutable attribution; status/pagination-independent aggregates; owner/token/tenant isolation; revoked owner session; concurrent CAS; calendar history recomputation; no delivery-side changes. Migration test checks exact preserved historical timestamps and invalid DB calendar arrays in a rolled-back isolated schema.

`npm run check`: passed (existing optional browser/DB checks skipped where their environment was absent).

Full `npm run test:cabinet` on isolated response DB: **105 pass,0 fail,0 skip** after037. Initial attempt before037 had one failing child test and its failing parent: `tests/cabinet.test.js`, “thread reads are job-bound and PostgreSQL forbids cross-owner message linkage”, HTTP500 vs200 because newly integrated media thread query required unapplied037. Applying037 resolved it. No remaining observed failure. Root owns fresh final combined verification as integration changes continue.

## Integration notes / limits

Modern Moscow operational dates use UTC+03; the calendar helper intentionally has no holiday calendar or historical pre-2014 Moscow offset reconstruction. Whole weeks are counted arithmetically; no unbounded per-day walk.

Live HTTP authentication remains the router/store's existing responsibility for reads; calendar writes explicitly use ownerTransaction. This module performs no network access. No known outstanding blocker for the current cabinet's operational data.
