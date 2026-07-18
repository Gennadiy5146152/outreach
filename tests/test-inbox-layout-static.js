import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const css = fs.readFileSync("public/styles.css", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");
const worker = fs.readFileSync("src/worker/index.js", "utf8");
const template = fs.readFileSync("src/services/template.js", "utf8");

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
  "function replyLinkText",
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
  "Привязка:",
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

for (const expected of [
  "export function cleanReplyText",
  "original message",
  "От|From",
]) {
  if (!template.includes(expected)) {
    throw new Error(`reply cleaner should include ${expected}`);
  }
}

for (const expected of [
  "cleanReplyText(parsed.text || \"\")",
]) {
  if (!worker.includes(expected)) {
    throw new Error(`worker should save cleaned inbound reply text: ${expected}`);
  }
}

for (const expected of [
  "function normalizeInboundReplyText",
  "function publicMessageRow",
  "function replyLinkInfo",
  "result.rows.map(publicMessageRow)",
  "chain_messages: (row.chain_messages || []).map(publicMessageRow)",
  "raw_headers: _rawHeaders",
]) {
  if (!server.includes(expected)) {
    throw new Error(`server should expose cleaned inbound reply text: ${expected}`);
  }
}

console.log("OK: inbox layout static test passed");
