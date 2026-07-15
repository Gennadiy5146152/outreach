import fs from "node:fs";

const server = fs.readFileSync("src/server.js", "utf8");
const template = fs.readFileSync("src/services/template.js", "utf8");
const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const css = fs.readFileSync("public/styles.css", "utf8");

for (const expected of [
  "async function checkMailboxConnection(mailbox)",
  "Promise.all([",
  "app.post(\"/api/campaigns/:id/preflight/fix\"",
  "tracking_disabled",
  "mailbox_check_failed",
  "Отключил отслеживание открытий",
]) {
  if (!server.includes(expected)) {
    throw new Error(`preflight autofix server code should include ${expected}`);
  }
}

for (const expected of [
  "contact: lead.contact_name || \"коллеги\"",
  "new Set([\"company\", \"email\"])",
]) {
  if (!template.includes(expected)) {
    throw new Error(`template fallback should include ${expected}`);
  }
}

for (const expected of [
  "Безопасные проблемы сервис попробует исправить сам",
  "preflightResult",
  "preflight-result",
]) {
  if (!index.includes(expected)) {
    throw new Error(`preflight screen should include ${expected}`);
  }
}

for (const expected of [
  "function renderPreflightResult(result, fixResult = null)",
  "preflight/fix",
  "Что сделано автоматически",
  "Что осталось закрыть",
  "Технические детали",
]) {
  if (!app.includes(expected)) {
    throw new Error(`preflight frontend should include ${expected}`);
  }
}

for (const expected of [".preflight-card", ".preflight-issue", ".preflight-stats"]) {
  if (!css.includes(expected)) {
    throw new Error(`preflight styles should include ${expected}`);
  }
}

if (index.includes("Preflight проверяет")) {
  throw new Error("preflight help text should be in plain Russian");
}

console.log("OK: preflight autofix static test passed");
