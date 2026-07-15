import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");

for (const expected of [
  "Проверять каждое письмо вручную перед отправкой",
  "Запустить отправку",
  "Поставить на ручную проверку",
  "Обычный запуск отправляет письма без дополнительного подтверждения",
]) {
  if (!index.includes(expected)) {
    throw new Error(`launch UI should include clear Russian text: ${expected}`);
  }
}

for (const forbidden of [
  "Ручное подтверждение пачки",
  "Запуск с подтверждением",
  "Автозапуск",
]) {
  if (index.includes(forbidden)) {
    throw new Error(`launch UI should not use confusing old text: ${forbidden}`);
  }
}

for (const expected of [
  "form.elements.manual_approval_required.checked = false",
  "manual: \"ручная проверка перед отправкой\"",
  "auto: \"обычная отправка\"",
  "result.requiresApproval",
  "дополнительное подтверждение не нужно",
]) {
  if (!app.includes(expected)) {
    throw new Error(`launch frontend should include ${expected}`);
  }
}

for (const expected of [
  "toBool(req.body.manual_approval_required ?? false)",
  "SELECT manual_approval_required FROM campaigns",
  "mode === \"manual\" || (mode === \"auto\" && campaign.manual_approval_required)",
  "res.json({ queued: result.rowCount, mode, requiresApproval, preflight })",
]) {
  if (!server.includes(expected)) {
    throw new Error(`launch backend should include ${expected}`);
  }
}

console.log("OK: campaign launch approval static test passed");
