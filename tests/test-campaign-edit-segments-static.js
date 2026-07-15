import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");
const css = fs.readFileSync("public/styles.css", "utf8");

for (const expected of [
  "name=\"campaign_id\" type=\"hidden\"",
  "data-segment-multi",
  "data-segment-chips",
  "Выбери один или несколько сегментов",
  "campaignEditResetBtn",
]) {
  if (!index.includes(expected)) {
    throw new Error(`campaign edit form should include ${expected}`);
  }
}

for (const expected of [
  "function splitSegments(value)",
  "function setSegmentPickerValue(picker, values)",
  "function syncCampaignSegmentInput()",
  "function editCampaign(campaignId)",
  "data-edit-campaign",
  "method: campaignId ? \"PATCH\" : \"POST\"",
  "data-remove-segment",
  "class=\"segment-option\"",
  "type=\"checkbox\" data-segment-value",
]) {
  if (!app.includes(expected)) {
    throw new Error(`campaign edit frontend should include ${expected}`);
  }
}

for (const expected of [
  "app.patch(\"/api/campaigns/:id\"",
  "UPDATE campaigns",
  "campaign_not_found",
  "regexp_split_to_table(segment, ',')",
]) {
  if (!server.includes(expected)) {
    throw new Error(`campaign edit API should include ${expected}`);
  }
}

for (const expected of [".segment-chips", ".segment-chip", ".segment-option"]) {
  if (!css.includes(expected)) {
    throw new Error(`multi segment CSS should include ${expected}`);
  }
}

console.log("OK: campaign edit and multi-segments static test passed");
