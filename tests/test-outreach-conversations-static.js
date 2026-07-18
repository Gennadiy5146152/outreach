import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");
const worker = fs.readFileSync("src/worker/index.js", "utf8");
const css = fs.readFileSync("public/styles.css", "utf8");

for (const expected of [
  "data-view=\"conversations\"",
  "data-view=\"review\"",
  "data-view=\"aiExport\"",
  "conversationsView",
  "reviewView",
  "aiExportView",
  "aiExportJsonlLink",
  "aiExportJsonLink",
  "aiExportCsvLink",
  "aiExportCampaign",
  "aiExportImport",
  "reviewClassificationFilter",
  "reviewExportLink",
  "conversationStatusFilter",
  "conversationClassificationFilter",
  "conversationReviewOnly",
  "conversationExportLink",
  "conversationDialog",
  "JSONL для ИИ",
  "Рабочая лента переписок",
  "data-conversation-preset=\"all\"",
  "data-conversation-preset=\"review\"",
  "data-conversation-preset=\"active\"",
  "data-conversation-preset=\"paused\"",
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
  "function aiExportQuery()",
  "function updateAiExportLinks()",
  "function renderAiExportFilters()",
  "campaign_id",
  "import_id",
  "function classificationSelect",
  "function conversationStatusExplanation",
  "function conversationLastDirection",
  "function conversationPreviewText",
  "function conversationActionButtons",
  "function applyConversationPreset",
  "async function openConversation",
  "Отменено будущих follow-up",
  "data-open-conversation",
  "data-stop-conversation",
  "data-continue-conversation",
  "data-conversation-preset",
  "data-conversation-delay-form",
  "data-classify-conversation",
  "data-conversation-reply-form",
  "История решений",
  "Отложить follow-up",
  "Перенос follow-up",
  "renderConversationEvents",
  "conversation-audit",
  "conversation-overview",
  "conversation-facts",
  "С входящими ответами",
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
  "outreachConversationExportRows",
  "app.get(\"/api/outreach/conversations/export.jsonl\"",
  "app.get(\"/api/outreach/conversations/export.json\"",
  "app.get(\"/api/outreach/conversations/export.csv\"",
  "app.get(\"/api/outreach/conversations/:id\"",
  "app.patch(\"/api/outreach/conversations/:id/classification\"",
  "STOPPING_REPLY_CLASSIFICATIONS",
  "Отменено после ручной классификации ответа",
  "app.post(\"/api/outreach/conversations/:id/stop\"",
  "app.post(\"/api/outreach/conversations/:id/continue\"",
  "app.post(\"/api/outreach/conversations/:id/delay\"",
  "app.post(\"/api/outreach/conversations/:id/reply\"",
  "outreach_conversation_stopped",
  "outreach_conversation_continued",
  "outreach_followup_delayed",
  "followup_postponed_needs_approval",
  "manual_reply_sent",
  "reply_classified",
  "payload->>'conversationId'",
  "previousStatus",
  "nextStatus",
  "nextAction",
  "reason: \"manual_stop\"",
  "sendMail(mailbox",
  "Content-Disposition",
  "campaign_name",
  "import_file_name",
  "oc.campaign_id = $9::uuid",
  "oc.import_id = $10::uuid",
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

for (const expected of [".conversation-card", ".conversation-card-head", ".conversation-thread", ".manual-reply-form", ".conversation-overview", ".conversation-facts", ".conversation-next"]) {
  if (!css.includes(expected)) {
    throw new Error(`conversations CSS should include ${expected}`);
  }
}

for (const expected of [".conversation-presets", "min-height: 28px", "font-size: 12px"]) {
  if (!css.includes(expected)) {
    throw new Error(`conversation preset filters should stay compact: ${expected}`);
  }
}

console.log("OK: outreach conversations static test passed");
