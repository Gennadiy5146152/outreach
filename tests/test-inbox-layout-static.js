import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const css = fs.readFileSync("public/styles.css", "utf8");

for (const expected of [
  "Здесь видны новые ответы",
  "inboxSummary",
  "data-inbox-filter=\"all\"",
  "data-inbox-filter=\"decision\"",
  "data-inbox-filter=\"outreach\"",
  "data-inbox-filter=\"positive\"",
]) {
  if (!index.includes(expected)) {
    throw new Error(`inbox page should include ${expected}`);
  }
}

for (const expected of [
  "inboxFilter: \"all\"",
  "function inboxClassificationOptions",
  "function inboxFilterLabel",
  "function inboxNeedsDecision",
  "function inboxPreviewText",
  "function inboxDecisionText",
  "function inboxVisibleItems",
  "inbox-card",
  "inbox-card-head",
  "inbox-preview",
  "inbox-next",
  "inbox-full",
  "inbox-message",
  "inbox-classify",
  "Без темы",
  "Класс ответа",
  "Показать полный текст",
  "Нужно разобрать",
  "statusLabel(value)",
]) {
  if (!app.includes(expected)) {
    throw new Error(`inbox rendering should include ${expected}`);
  }
}

for (const expected of [
  ".inbox-card",
  ".inbox-card-head",
  ".inbox-preview",
  ".inbox-next",
  ".inbox-actions",
  ".inbox-full",
  ".inbox-filters",
  ".inbox-message",
  "overflow-wrap: anywhere",
  "word-break: break-word",
  "min-width: 0",
  "min-height: 28px",
]) {
  if (!css.includes(expected)) {
    throw new Error(`inbox layout CSS should include ${expected}`);
  }
}

console.log("OK: inbox layout static test passed");
