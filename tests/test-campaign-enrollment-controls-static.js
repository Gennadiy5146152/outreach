import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");
const css = fs.readFileSync("public/styles.css", "utf8");

for (const expected of [
  "campaignEnrollmentSelectAll",
  "campaignEnrollmentSelection",
  "keepCampaignLeadsBtn",
  "Оставить выбранных",
]) {
  if (!index.includes(expected)) {
    throw new Error(`campaign enrollment UI should include ${expected}`);
  }
}

for (const expected of [
  "selectedCampaignEnrollmentIds: new Set()",
  "function updateCampaignEnrollmentSelection()",
  "data-campaign-enrollment-id",
  "data-pause-enrollment",
  "enrollments/keep-selected",
  "/api/enrollments/${pauseEnrollment.dataset.pauseEnrollment}/pause",
  "Выбрано для отправки",
  "отправятся:",
]) {
  if (!app.includes(expected)) {
    throw new Error(`campaign enrollment frontend should include ${expected}`);
  }
}

for (const expected of [
  "app.post(\"/api/campaigns/:id/enrollments/keep-selected\"",
  "app.post(\"/api/enrollments/:id/pause\"",
  "status = 'paused'",
  "stop_reason = 'paused_by_user'",
  "status = 'cancelled'",
  "status IN ('pending','retrying')",
]) {
  if (!server.includes(expected)) {
    throw new Error(`campaign enrollment API should include ${expected}`);
  }
}

for (const expected of [".small-button", ".muted-row", ".lead-bulkbar button"]) {
  if (!css.includes(expected)) {
    throw new Error(`campaign enrollment styles should include ${expected}`);
  }
}

console.log("OK: campaign enrollment controls static test passed");
