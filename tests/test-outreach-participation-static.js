import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");
const css = fs.readFileSync("public/styles.css", "utf8");

for (const expected of [
  "data-view=\"participation\"",
  "participationView",
  "participationSearch",
  "data-participation-status",
  "participation-status-filters",
  "participationMailbox",
  "participationImport",
  "participationRun",
  "stopParticipationRunBtn",
  "openParticipationRunBtn",
  "participationRunContext",
  "participationSummary",
  "participationCampaign",
  "participationTable",
]) {
  if (!index.includes(expected)) {
    throw new Error(`participation UI should include ${expected}`);
  }
}

for (const expected of [
  "participationRows: []",
  "expandedParticipationRows: new Set()",
  "participationRequestId: 0",
  "participationOptionsLoaded: false",
  "participationFilters",
  "participationOptions",
  "import_id",
  "participation: \"Участие\"",
  "async function loadParticipation(",
  "function renderParticipationTable()",
  "function participationQueryString(",
  "function participationRowStatus(row)",
  "function participationProgressText(row)",
  "function setParticipationLoading(loading)",
  "data-participation-row-toggle",
  "data-open-participation-run",
  "includeFilters",
  "loadParticipation.searchTimer",
]) {
  if (!app.includes(expected)) {
    throw new Error(`participation frontend should include ${expected}`);
  }
}

for (const expected of [
  "app.get(\"/api/outreach/participation\"",
  "WITH group_keys AS",
  "FROM sending_queue",
  "FROM messages",
  "participation_status",
  "COALESCE(s.import_file_name, s.run_title",
  "followup_pending",
  "followup_cancelled",
  "import_id = $6::uuid",
  "last_reply_classification",
  "filtered_replied",
  "filtered_completed",
  "include_filters",
  "'active_queue', run_option.active_queue",
  "cancelled_queue, 0) > 0 AND COALESCE(s.active_queue, 0) = 0",
  "'status', run_option.status",
]) {
  if (!server.includes(expected)) {
    throw new Error(`participation API should include ${expected}`);
  }
}

for (const expected of [
  ".participation-toolbar",
  ".participation-filter-grid",
  ".participation-run-context",
  ".participation-summary",
  ".participation-status",
  ".participation-details",
]) {
  if (!css.includes(expected)) {
    throw new Error(`participation CSS should include ${expected}`);
  }
}

console.log("OK: outreach participation static test passed");
