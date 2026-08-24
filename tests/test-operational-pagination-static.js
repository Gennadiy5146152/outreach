import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const css = fs.readFileSync("public/styles.css", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");
const worker = fs.readFileSync("src/worker/index.js", "utf8");

for (const expected of [
  "queuePagination",
  "runRowsPagination",
  "participationPagination",
  "inboxPagination",
  "reviewPagination",
  "conversationPagination",
  "navOpenBtn",
  "navBackdrop",
  "data-entry-disclosure",
]) {
  if (!index.includes(expected)) throw new Error(`operational UI should include ${expected}`);
}

for (const expected of [
  "function renderPagination",
  "function paginationScope",
  "filter: state.queueFilter",
  "filter: state.inboxFilter",
  "state.conversationPagination",
  "state.reviewPagination",
  "data-dismiss-action-result",
  "function compactMessageText",
  "window.scrollTo({ top: 0",
]) {
  if (!app.includes(expected)) throw new Error(`operational client should include ${expected}`);
}

for (const expected of [
  ".operational-table",
  "position: sticky",
  "#runsView.active",
  "body.nav-open .sidebar",
  ".pagination-actions",
]) {
  if (!css.includes(expected)) throw new Error(`operational layout should include ${expected}`);
}

for (const expected of [
  "function paginationParams",
  "function paginationMeta",
  "pagination: paginationMeta",
  "WITH latest_conversations AS",
  "AND ($3 = false OR status IN ('waiting_reply_review','manual_reply_needed'))",
  "WITH ranked AS",
  "LIMIT $2 OFFSET $3",
  "first_reply_at >= first_sent_at",
]) {
  if (!server.includes(expected)) throw new Error(`operational API should include ${expected}`);
}

if (!worker.includes("$31,$32,$33,$34)")) {
  throw new Error("inbound message INSERT should keep values aligned with target columns");
}

console.log("OK: operational pagination static test passed");
