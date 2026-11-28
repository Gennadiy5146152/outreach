# Response-speed UI handoff

Ready for root integration; no router/backend/cabinet integration files changed by this worker.

Files: `public/cabinet-response.js`, `tests/cabinet-response-ui.test.js`, `docs/superpowers/briefs/2026-11-28-response-ui-fragment.html`, `docs/superpowers/briefs/2026-11-28-response-ui-styles.css`.

## Integration

Insert the whole HTML fragment as a workspace page. Keep its calendar dialog nested inside `#response` so scoped styles apply. Append the stylesheet fragment to cabinet.css. All IDs start `response`, all styling is scoped to this page.

Import `createCabinetResponse` and instantiate with `{api,at,onCampaignChange}`. `api(path,body,method)` follows the existing cabinet convention. `at` should format complete timestamps including seconds. The returned `{setCampaigns(list),select(id),refresh()}` matches existing stats/followups controller patterns. Populate campaign options from the global campaign list, call `select(campaignId)` when it changes (empty ID clears all displayed data), and refresh when navigating to `#response`. Add nav text “Скорость ответа”. Existing owner-only cabinet bootstrap allows calendar editing; server remains authoritative for PATCH authorization.

Principal IDs: `responseFilters`, `responseCampaign`, `responseFrom`, `responseTo`, `responseGroup`, `responseMode`, `responseSide`, `responseStatus`, `responseRefresh`, `responseCalendar`, `responseMedian`, `responseP90`, `responsePending`, `responseOldest`, `responseTrend`, `responseSources`, `responseRows`, `responsePage`, `responsePrev`, `responseNext`, `responseError`. Calendar: `responseScheduleDialog`, `responseScheduleEdit`, `responseScheduleForm`, `responseWeekdays`, `responseScheduleStart`, `responseScheduleEnd`, `responseScheduleSave`, `responseScheduleCancel`, `responseScheduleError`.

## API and behavior

GET `/campaigns/:id/response-analytics` with mode, side, status, page, page_size=20 and nonempty optional from/to/group_username. PATCH `/campaigns/:id/response-schedule` with `{weekdays,start,end,expected_revision}`. ISO weekdays 1–7. Current saved revision is captured per editor but omitted from visible product copy at root's request. Side labels: “Ответ Артёма клиенту” and “Ответ клиента на обращение”.

Answered-only median/p90 preserve null as a dash. Pending age remains nonzero when appropriate, labelled neutrally; anomalies show reason and no duration. Timestamp cells call `at` with the source ISO timestamp and flag `service_receipt`. Duration titles expose both elapsed/working durations. Daily chart uses only server observations, and per-source cards expose median, p90 and counts. Date basis and current calendar recomputation are explicitly explained. No delivery actions exist in this component.

One in-flight analytics request queues one refresh with the latest filters; generations protect campaign/page/mode changes. Selected source remains present if new date results lack it. Clearing campaign removes rows, metrics, sources, calendar and dialogs. Calendar saves capture editor identity; stale success/failure cannot close, error or re-enable a replacement editor. Validation enforces nonempty weekdays and start<end; conflict gives refresh/reopen instructions.

## Verification

Initial RED: all four behavior tests failed because the new component module was absent. GREEN: five real Chromium tests passed with API-boundary fixtures, no database/network dependency:

- Empty answered metrics, exact timestamps, provenance, anomalies, real trend points and desktop/mobile no overflow.
- Mode/side/date/source/status query and pagination preserving active filters.
- Latest-filter queue, absent selected source retention, campaign request races, campaign clear.
- Weekday/hour validation, exact revision PATCH, visible CAS conflict, delayed save/replacement editor isolation.
- Successful save closes current editor, refreshes calendar and uses persisted values on reopen.

Command: `PUPPETEER_MODULE=/Users/alex/Documents/ChatGPT/Клиенты/KorDevTeam-web-api/node_modules/puppeteer/lib/cjs/puppeteer/puppeteer.js node --test tests/cabinet-response-ui.test.js`.

`node --check public/cabinet-response.js` passed. Full `npm run check` passed (legacy optional browser/DB suites skip when their environment is absent); the dedicated five new browser tests above ran with no skips. Desktop 1400px and mobile 390px screenshots visually inspected; temporary screenshots `/tmp/response-1400.png` and `/tmp/response-390.png`.

Root still owns actual cabinet injection/API render and final review. No deployment/commit performed. No unresolved component issues identified.
