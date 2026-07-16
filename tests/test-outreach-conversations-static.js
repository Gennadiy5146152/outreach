import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");
const worker = fs.readFileSync("src/worker/index.js", "utf8");
const css = fs.readFileSync("public/styles.css", "utf8");

for (const expected of [
  "data-view=\"conversations\"",
  "data-view=\"review\"",
  "conversationsView",
  "reviewView",
  "reviewClassificationFilter",
  "reviewExportLink",
  "conversationStatusFilter",
  "conversationClassificationFilter",
  "conversationReviewOnly",
  "conversationExportLink",
  "conversationDialog",
  "JSONL для ИИ",
]) {
  if (!index.includes(expected)) {
    throw new Error(`conversations UI should include ${expected}`);
  }
}

for (const expected of [
  "outreachConversations: []",
  "reviewConversations: []",
  "async function loadConversations()",
  "async function loadReviewConversations()",
  "function conversationQuery()",
  "function reviewQuery()",
  "function classificationSelect",
  "async function openConversation",
  "Отменено будущих follow-up",
  "data-open-conversation",
  "data-stop-conversation",
  "data-continue-conversation",
  "data-classify-conversation",
  "data-conversation-reply-form",
  "Отправка ручного ответа",
  "После ручного ответа остановить будущие follow-up",
  "$(\"#closeConversationDialog\").addEventListener",
]) {
  if (!app.includes(expected)) {
    throw new Error(`conversations frontend should include ${expected}`);
  }
}

for (const expected of [
  "app.get(\"/api/outreach/conversations\"",
  "app.get(\"/api/outreach/conversations/export.jsonl\"",
  "app.get(\"/api/outreach/conversations/:id\"",
  "app.patch(\"/api/outreach/conversations/:id/classification\"",
  "STOPPING_REPLY_CLASSIFICATIONS",
  "Отменено после ручной классификации ответа",
  "app.post(\"/api/outreach/conversations/:id/stop\"",
  "app.post(\"/api/outreach/conversations/:id/continue\"",
  "app.post(\"/api/outreach/conversations/:id/reply\"",
  "outreach_conversation_stopped",
  "outreach_conversation_continued",
  "manual_reply_sent",
  "reply_classified",
  "sendMail(mailbox",
  "Content-Disposition",
]) {
  if (!server.includes(expected)) {
    throw new Error(`conversations API should include ${expected}`);
  }
}

if (!server.includes("WHERE msg.lead_id = oc.lead_id") || !server.includes("type <> 'warmup'")) {
  throw new Error("conversations API should build non-warmup threads by lead");
}

if (!server.includes("oc.classification = $2")) {
  throw new Error("conversations export/list should support classification filtering");
}

if (!worker.includes("status = 'waiting_reply_review'")) {
  throw new Error("worker should move replied conversations into review queue");
}

for (const expected of [".conversation-card", ".conversation-card-head", ".conversation-thread", ".manual-reply-form"]) {
  if (!css.includes(expected)) {
    throw new Error(`conversations CSS should include ${expected}`);
  }
}

console.log("OK: outreach conversations static test passed");
