import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");
const outreachControl = fs.readFileSync("src/services/outreach-control.js", "utf8");
const worker = fs.readFileSync("src/worker/index.js", "utf8");
const migration = fs.readFileSync("db/migrations/010_outreach_runs.sql", "utf8");
const css = fs.readFileSync("public/styles.css", "utf8");

for (const expected of [
  "data-view=\"runs\"",
  "runsView",
  "runRowsTable",
  "runRowsSelectVisible",
  "runs-list-collapsed",
  "runQuickSelect",
  "toggleRunsListBtn",
  "stopActiveRunBtn",
  "stopAllOutreachBtn",
  "Остановить всю рассылку",
  "Остановить follow-up",
  "Продолжить follow-up",
  "runStatusBadge",
  "runSelectionActions",
  "Выбрать строки на странице",
]) {
  if (!index.includes(expected)) {
    throw new Error(`runs UI should include ${expected}`);
  }
}

for (const expected of [
  "runs: []",
  "runDetail: null",
  "selectedRunLeadIds: new Set()",
  "expandedRunRows: new Set()",
  "expandedRunActions: new Set()",
  "runDetailCache: new Map()",
  "function visibleRunRows()",
  "function renderRunRows()",
  "function renderRunsList()",
  "function setRunsListCollapsed(collapsed)",
  "function runOperationalStatus(run)",
  "function runOperationalStatusLabel(run)",
  "async function loadRunDetail",
  "async function selectRun",
  "async function loadRuns",
  "async function runActionForLeads",
  "data-run-lead-select",
  "data-run-actions-toggle",
  "run-expanded-actions",
  "runRowsSelectAll",
  "runRowsSelectVisible",
  "runBulkSelection",
  "stopActiveRunBtn",
  "stopParticipationRunBtn",
  "async function stopRun",
  "async function stopAllOutreach",
  "function activeRunCanBeStopped()",
  "activeRunStatus() === \"running\" && activeRunHasActiveQueue()",
  "state.runDetailCache.clear()",
  "renderParticipationFilters();",
  "stop-followups",
  "continue-followups",
  "approved_queue",
  "Разрешено писем",
]) {
  if (!app.includes(expected)) {
    throw new Error(`runs frontend should include ${expected}`);
  }
}

for (const expected of [
  "CREATE TABLE IF NOT EXISTS outreach_runs",
  "ADD COLUMN IF NOT EXISTS run_id",
  "sending_queue_run_idx",
  "messages_run_idx",
]) {
  if (!migration.includes(expected)) {
    throw new Error(`runs migration should include ${expected}`);
  }
}

for (const expected of [
  "app.get(\"/api/outreach/runs\"",
  "app.get(\"/api/outreach/runs/:id\"",
  "app.post(\"/api/outreach/runs/:id/stop\"",
  "app.get(\"/api/outreach/stop-all/impact\"",
  "app.post(\"/api/outreach/stop-all\"",
  "app.post(\"/api/outreach/runs/:id/stop-followups\"",
  "app.post(\"/api/outreach/runs/:id/continue-followups\"",
  "app.post(\"/api/outreach/runs/:id/suppress\"",
  "COALESCE(msg.received_at, msg.created_at) >= r.created_at",
  "COALESCE(msg.received_at, msg.created_at) >= $2::timestamptz",
  "msg.raw_headers->>'x-outreach-parsed-from'",
  "msg.raw_headers->>'from'",
  "sent.message_id_header",
  "msg.in_reply_to",
  "msg.references_header",
  "q.requires_approval = true",
  "approved_at = now()",
  "approved_queue",
  "run_id = $1",
  "run_stopped_by_user",
  "outreach_run_stopped",
  "Запуск полностью остановлен пользователем",
]) {
  if (!server.includes(expected)) {
    throw new Error(`runs API should include ${expected}`);
  }
}

for (const expected of [
  "Вся рассылка остановлена пользователем",
  "all_outreach_stopped_by_user",
  "mode <> 'test'",
]) {
  if (!outreachControl.includes(expected)) {
    throw new Error(`global outreach stop should include ${expected}`);
  }
}

for (const expected of [
  "latest_queue.run_id",
  "item.run_id || null",
  "linked?.run_id || null",
]) {
  if (!worker.includes(expected)) {
    throw new Error(`worker should preserve run linkage: ${expected}`);
  }
}

for (const expected of [
  ".run-list",
  "#runsView.runs-list-collapsed.active",
  ".run-bulkbar",
  ".run-status-badge",
  ".run-selection-actions",
  ".run-row-actions",
  ".run-expanded-actions",
  ".run-detail-loading",
  ".run-row.needs-decision",
  ".run-timeline",
]) {
  if (!css.includes(expected)) {
    throw new Error(`runs CSS should include ${expected}`);
  }
}

if (css.includes("#runRowsTable th:nth-child(2)")) {
  throw new Error("runs table should not pin the company column");
}

console.log("OK: outreach runs static test passed");
