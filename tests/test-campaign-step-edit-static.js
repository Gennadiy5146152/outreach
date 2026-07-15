import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");
const css = fs.readFileSync("public/styles.css", "utf8");

for (const expected of [
  "name=\"step_id\" type=\"hidden\"",
  "campaignStepList",
  "Отменить редактирование",
  "Шаги этой кампании",
  "Текст без оформления",
]) {
  if (!index.includes(expected)) {
    throw new Error(`step form should include ${expected}`);
  }
}

for (const expected of [
  "function renderCampaignStepList()",
  "function editCampaignStep(stepId)",
  "function resetStepForm()",
  "data-edit-step",
  "method: stepId ? \"PATCH\" : \"POST\"",
  "switchCampaignStep(\"letter\")",
  "добавлен и показан справа",
]) {
  if (!app.includes(expected)) {
    throw new Error(`step editing frontend should include ${expected}`);
  }
}

const stepSubmitStart = app.indexOf("$(\"#stepForm\").addEventListener");
const stepSubmitEnd = app.indexOf("$(\"#attachmentForm\").addEventListener", stepSubmitStart);
const stepSubmitCode = app.slice(stepSubmitStart, stepSubmitEnd);

if (stepSubmitCode.includes("switchCampaignStep(\"leads\")")) {
  throw new Error("adding or editing a step should not jump to the leads screen");
}

for (const expected of [
  "app.patch(\"/api/steps/:id\"",
  "UPDATE campaign_steps",
  "campaign_step_not_found",
]) {
  if (!server.includes(expected)) {
    throw new Error(`step editing API should include ${expected}`);
  }
}

for (const expected of [".campaign-step-list", ".campaign-step-card", ".step-preview"]) {
  if (!css.includes(expected)) {
    throw new Error(`step editing CSS should include ${expected}`);
  }
}

console.log("OK: campaign step editing static test passed");
