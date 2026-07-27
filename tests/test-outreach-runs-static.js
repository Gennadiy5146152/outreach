import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");
const worker = fs.readFileSync("src/worker/index.js", "utf8");
const migration = fs.readFileSync("db/migrations/010_outreach_runs.sql", "utf8");
const css = fs.readFileSync("public/styles.css", "utf8");

for (const expected of [
  "data-view=\"runs\"",
  "runsView",
  "runRowsTable",
  "runRowsSelectVisible",
  "Остановить выбранные follow-up",
  "Продолжить выбранные follow-up",
  "В стоп-лист выбранные",
  "Выбрать все строки по фильтру",
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
  "function visibleRunRows()",
  "function renderRunRows()",
  "async function loadRuns",
  "async function runActionForLeads",
  "data-run-lead-select",
  "runRowsSelectAll",
  "runRowsSelectVisible",
  "runBulkSelection",
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
  "app.post(\"/api/outreach/runs/:id/stop-followups\"",
  "app.post(\"/api/outreach/runs/:id/continue-followups\"",
  "app.post(\"/api/outreach/runs/:id/suppress\"",
  "q.requires_approval = true",
  "approved_at = now()",
  "approved_queue",
  "run_id = $1",
]) {
  if (!server.includes(expected)) {
    throw new Error(`runs API should include ${expected}`);
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
  ".run-bulkbar",
  ".run-row.needs-decision",
  ".run-timeline",
]) {
  if (!css.includes(expected)) {
    throw new Error(`runs CSS should include ${expected}`);
  }
}

console.log("OK: outreach runs static test passed");
