import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const css = fs.readFileSync("public/styles.css", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");

for (const expected of [
  "id=\"attachmentForm\" class=\"attachment-form\"",
  "<span>Шаг письма</span>",
  "id=\"attachmentStep\" required",
  "<span>Файл</span>",
  "Загрузить вложение",
]) {
  if (!index.includes(expected)) {
    throw new Error(`attachment form markup should include ${expected}`);
  }
}

for (const expected of [
  ".attachment-form",
  "grid-template-columns: minmax(180px, 0.9fr) minmax(220px, 1.1fr)",
  ".attachment-form input[type=\"file\"]",
  ".attachment-form button",
]) {
  if (!css.includes(expected)) {
    throw new Error(`attachment form CSS should include ${expected}`);
  }
}

for (const expected of [
  "Сначала добавь шаг письма",
  "$(\"#attachmentForm button\").disabled = attachmentSteps.length === 0",
  "stepId === \"null\"",
]) {
  if (!app.includes(expected)) {
    throw new Error(`attachment form behavior should include ${expected}`);
  }
}

for (const expected of [
  "function isUuid",
  "campaign_step_required",
  "campaign_step_not_found",
  "SELECT id FROM campaign_steps WHERE id = $1",
]) {
  if (!server.includes(expected)) {
    throw new Error(`attachment endpoint should include ${expected}`);
  }
}

console.log("OK: attachment form layout static test passed");
