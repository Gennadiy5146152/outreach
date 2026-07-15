import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");
const css = fs.readFileSync("public/styles.css", "utf8");

for (const expected of [
  "Уже в кампании",
  "campaignLeadsSummary",
]) {
  if (!index.includes(expected)) {
    throw new Error(`campaign enrollment UI should include ${expected}`);
  }
}

for (const forbidden of [
  "campaignEnrollmentSelectAll",
  "campaignEnrollmentSelection",
  "keepCampaignLeadsBtn",
  "Оставить выбранных",
  "Выбрать всех активных",
]) {
  if (index.includes(forbidden)) {
    throw new Error(`campaign enrollment UI should not include confusing bulk control: ${forbidden}`);
  }
}

for (const expected of [
  "data-campaign-send-toggle",
  "send-toggle",
  "Отправлять",
  "Выключить лида из отправки",
  "/api/enrollments/${enrollmentId}/${enabled ? \"resume\" : \"pause\"}",
  "отправятся:",
]) {
  if (!app.includes(expected)) {
    throw new Error(`campaign enrollment frontend should include ${expected}`);
  }
}

for (const forbidden of [
  "selectedCampaignEnrollmentIds",
  "function updateCampaignEnrollmentSelection()",
  "data-campaign-enrollment-id",
  "data-pause-enrollment",
  "data-resume-enrollment",
]) {
  if (app.includes(forbidden)) {
    throw new Error(`campaign enrollment frontend should not include old bulk/select UI: ${forbidden}`);
  }
}

for (const expected of [
  "app.post(\"/api/campaigns/:id/enrollments/keep-selected\"",
  "app.post(\"/api/enrollments/:id/pause\"",
  "app.post(\"/api/enrollments/:id/resume\"",
  "status = 'paused'",
  "status = 'active'",
  "stop_reason = 'paused_by_user'",
  "status = 'cancelled'",
  "status IN ('pending','retrying')",
]) {
  if (!server.includes(expected)) {
    throw new Error(`campaign enrollment API should include ${expected}`);
  }
}

for (const expected of [".send-toggle", ".muted-row", ".lead-bulkbar button"]) {
  if (!css.includes(expected)) {
    throw new Error(`campaign enrollment styles should include ${expected}`);
  }
}

console.log("OK: campaign enrollment controls static test passed");
