import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");
const css = fs.readFileSync("public/styles.css", "utf8");

for (const expected of [
  "campaignLeadsSummary",
  "campaignLeadsTable",
  "campaignAvailableLeadsTable",
  "Добавить выбранных лидов",
]) {
  if (!index.includes(expected)) {
    throw new Error(`campaign leads panel should include ${expected}`);
  }
}

for (const expected of [
  "campaignLeads: []",
  "async function loadCampaignLeads()",
  "api(`/api/campaigns/${campaignId}/leads`)",
  "$(\"#activeCampaign\").addEventListener(\"change\", () => loadCampaignLeads())",
  "В этой кампании пока нет лидов",
]) {
  if (!app.includes(expected)) {
    throw new Error(`campaign leads frontend should include ${expected}`);
  }
}

for (const expected of [
  "app.get(\"/api/campaigns/:id/leads\"",
  "FROM enrollments e",
  "JOIN leads l ON l.id = e.lead_id",
  "LEFT JOIN mailboxes m ON m.id = e.mailbox_id",
]) {
  if (!server.includes(expected)) {
    throw new Error(`campaign leads API should include ${expected}`);
  }
}

if (!css.includes(".summary-line")) {
  throw new Error("campaign leads summary should have styles");
}

console.log("OK: campaign leads static test passed");
