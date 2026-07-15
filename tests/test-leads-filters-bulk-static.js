import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");
const css = fs.readFileSync("public/styles.css", "utf8");

for (const expected of [
  "leadSegmentFilter",
  "leadValidationFilter",
  "leadFiltersReset",
  "campaignAvailableLeadsTable",
  "campaignLeadSelectAll",
  "Добавить выбранных лидов",
  "Новые лиды для добавления",
  "Уже в кампании",
]) {
  if (!index.includes(expected)) {
    throw new Error(`lead filtering UI should include ${expected}`);
  }
}

for (const expected of [
  "selectedCampaignLeadIds: new Set()",
  "function renderLeadSegmentFilter()",
  "async function loadCampaignAvailableLeads()",
  "function renderCampaignAvailableLeads()",
  "/available-leads",
  "data-campaign-lead-id",
  "Выбери хотя бы одного лида",
  "Все подходящие лиды уже добавлены",
  "selectAll.disabled = available.length === 0",
  "enrollButton.disabled = count === 0",
  "leadValidationFilter",
]) {
  if (!app.includes(expected)) {
    throw new Error(`lead filtering frontend should include ${expected}`);
  }
}

for (const expected of [
  "const segment = cleanText(req.query.segment)",
  "AND ($4 = '' OR segment = $4)",
  "app.get(\"/api/campaigns/:id/available-leads\"",
  "l.validation_status IN ('valid', 'risky')",
  "NOT EXISTS (SELECT 1 FROM campaign_segments)",
]) {
  if (!server.includes(expected)) {
    throw new Error(`lead filtering API should include ${expected}`);
  }
}

for (const expected of [".lead-filters", ".lead-bulkbar", ".subsection-title"]) {
  if (!css.includes(expected)) {
    throw new Error(`lead filtering styles should include ${expected}`);
  }
}

console.log("OK: leads filters and bulk selection static test passed");
