import fs from "node:fs";

const app = fs.readFileSync("public/app.js", "utf8");
const campaignListStart = app.indexOf("$(\"#campaignList\").innerHTML");
const campaignListEnd = app.indexOf("renderSetupChecklist();", campaignListStart);
const campaignListCode = app.slice(campaignListStart, campaignListEnd);

for (const expected of [
  "Шагов:",
  "Отслеживание открытий:",
  "Ручная проверка писем:",
  "\"включено\" : \"выключено\"",
]) {
  if (!campaignListCode.includes(expected)) {
    throw new Error(`campaign card should include Russian label: ${expected}`);
  }
}

for (const forbidden of ["tracking:", "manual:", "\"on\" : \"off\""]) {
  if (campaignListCode.includes(forbidden)) {
    throw new Error(`campaign card should not expose English technical label: ${forbidden}`);
  }
}

console.log("OK: campaign card labels static test passed");
