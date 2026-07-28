import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");

for (const expected of [
  "data-view=\"participation\"",
  "participationView",
  "participationSearch",
  "participationStatus",
  "participationMailbox",
  "participationImport",
  "participationRun",
  "participationCampaign",
  "participationTable",
]) {
  if (!index.includes(expected)) {
    throw new Error(`participation UI should include ${expected}`);
  }
}

for (const expected of [
  "participationRows: []",
  "participationFilters",
  "participationOptions",
  "import_id",
  "participation: \"Участие\"",
  "async function loadParticipation()",
  "function renderParticipationTable()",
  "function participationQueryString()",
  "data-open-participation-run",
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
]) {
  if (!server.includes(expected)) {
    throw new Error(`participation API should include ${expected}`);
  }
}

console.log("OK: outreach participation static test passed");
