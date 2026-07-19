import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.YANDEX_GPT_MOCK = "1";

const {
  analyzeInboundReplyWithAi,
  analyzeCampaignResultsWithAi,
  buildReplyClassificationPrompt,
  buildCampaignAnalysisPrompt,
  buildThreadMatchPrompt,
  safeParseJsonFromAi,
  suggestThreadMatchWithAi,
} = await import("../src/services/ai-reply.js");

const prompt = buildReplyClassificationPrompt({
  subject: "Интересно обсудить",
  body: "Да, пришлите подробности и цену.",
  fallbackClassification: "neutral_reply",
});

assert.ok(prompt.includes("Допустимые classification"), "prompt should explain classification contract");
assert.ok(prompt.includes("Текст ответа:"), "prompt should include reply body section");

const parsed = safeParseJsonFromAi('```json\n{"classification":"negative_reply","confidence":0.8,"reason":"отказ"}\n```');
assert.equal(parsed.classification, "negative_reply", "parser should handle fenced JSON");

const result = await analyzeInboundReplyWithAi({
  subject: "Интересно обсудить",
  body: "Да, пришлите подробности и цену.",
  fallbackClassification: "neutral_reply",
});

assert.equal(result.source, "ai", "mocked Yandex GPT should be used when enabled");
assert.equal(result.classification, "positive_reply", "mocked result should normalize classification");
assert.equal(result.ai.confidence, 0.91, "mocked confidence should be preserved");
assert.equal(result.ai.model, "mock", "mocked model should be visible for audit");
assert.equal(result.ai.funnelStage, "details_requested", "AI should return funnel stage");
assert.equal(result.ai.leadTemperature, "warm", "AI should return lead temperature");
assert.equal(result.ai.replyReason, "wants_details", "AI should return reply reason");
assert.equal(result.ai.nextBestAction, "reply_manually", "AI should return next best action");
assert.ok(result.ai.summary.includes("подробности"), "AI should return short summary");
assert.ok(result.ai.replyDraft.includes("Спасибо за интерес"), "AI should return manual reply draft");
assert.ok(result.ai.draftGoal.includes("продолжить диалог"), "AI should return draft goal");
assert.equal(result.ai.needsUserEdit, true, "AI draft should require user review");

const threadPrompt = buildThreadMatchPrompt({
  inboundSubject: "Re: Оплата",
  inboundBody: "Да, по оплате вернусь завтра.",
  fromEmail: "client@example.com",
  candidates: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      subject: "Оплата по проекту",
      body_text: "Когда сможете закрыть оплату?",
      sent_at: "2026-07-19T09:00:00.000Z",
    },
  ],
});

assert.ok(threadPrompt.includes("suggested_message_id"), "thread prompt should request suggested message id");
const threadSuggestion = await suggestThreadMatchWithAi({
  inboundSubject: "Re: Оплата",
  inboundBody: "Да, по оплате вернусь завтра.",
  fromEmail: "client@example.com",
  candidates: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      subject: "Оплата по проекту",
      body_text: "Когда сможете закрыть оплату?",
      sent_at: "2026-07-19T09:00:00.000Z",
    },
  ],
});
assert.equal(threadSuggestion.suggestedMessageId, "11111111-1111-4111-8111-111111111111", "AI should suggest candidate thread");
assert.equal(threadSuggestion.needsHumanReview, false, "high-confidence mock suggestion should not require review");

const campaignPrompt = buildCampaignAnalysisPrompt({
  rows: [
    {
      lead: { email: "client@example.com", company: "Компания", segment: "B2B услуги" },
      conversation: { status: "waiting_reply_review", classification: "positive_reply", inbound_total: 1 },
      messages: [{ direction: "inbound", subject: "Re", body: "Пришлите подробности", classification: "positive_reply" }],
    },
  ],
});
assert.ok(campaignPrompt.includes("campaign_summary"), "campaign prompt should request campaign summary");
const campaignAnalysis = await analyzeCampaignResultsWithAi({
  rows: [
    {
      lead: { email: "client@example.com", company: "Компания", segment: "B2B услуги" },
      conversation: { status: "waiting_reply_review", classification: "positive_reply", inbound_total: 1 },
      messages: [{ direction: "inbound", subject: "Re", body: "Пришлите подробности", classification: "positive_reply" }],
    },
  ],
});
assert.equal(campaignAnalysis.ok, true, "mocked campaign analysis should succeed");
assert.ok(campaignAnalysis.campaign_summary.includes("теплые лиды"), "campaign analysis should return summary");
assert.ok(campaignAnalysis.recommended_changes.length, "campaign analysis should return recommendations");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = fs.readFileSync(path.join(root, "src/worker/index.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "db/migrations/006_ai_reply_analysis.sql"), "utf8");
const funnelMigration = fs.readFileSync(path.join(root, "db/migrations/007_ai_funnel_insights.sql"), "utf8");
const draftMigration = fs.readFileSync(path.join(root, "db/migrations/008_ai_reply_drafts.sql"), "utf8");
const campaignMigration = fs.readFileSync(path.join(root, "db/migrations/009_ai_campaign_analysis.sql"), "utf8");
const publicApp = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const publicHtml = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const server = fs.readFileSync(path.join(root, "src/server.js"), "utf8");

assert.ok(worker.includes("analyzeInboundReplyWithAi"), "worker should call AI reply analysis");
assert.ok(worker.includes("suggestThreadMatchWithAi"), "worker should call AI thread matcher");
assert.ok(worker.includes("findLinkedOutboundWithAi"), "worker should route weak thread matching through AI helper");
assert.ok(worker.includes("ai_semantic"), "worker should mark AI semantic links");
assert.ok(worker.includes("inbound_ai_classified"), "worker should log AI classification event");
assert.ok(worker.includes("inbound_ai_thread_match"), "worker should log AI thread match event");
assert.ok(worker.includes("ai_classification, ai_confidence, ai_reason"), "worker should insert AI columns");
assert.ok(worker.includes("ai_funnel_stage, ai_lead_temperature, ai_reply_reason"), "worker should insert AI funnel columns");
assert.ok(worker.includes("ai_reply_draft, ai_draft_goal, ai_draft_needs_user_edit"), "worker should insert AI draft columns");
assert.ok(worker.includes("applyAiConversationInsights"), "worker should copy AI insights to conversations");
assert.ok(migration.includes("ADD COLUMN IF NOT EXISTS ai_classification text"), "migration should add ai_classification");
assert.ok(migration.includes("ADD COLUMN IF NOT EXISTS ai_confidence numeric"), "migration should add ai_confidence");
assert.ok(funnelMigration.includes("ADD COLUMN IF NOT EXISTS ai_funnel_stage text"), "funnel migration should add message funnel stage");
assert.ok(funnelMigration.includes("ADD COLUMN IF NOT EXISTS lead_temperature text"), "funnel migration should add conversation lead temperature");
assert.ok(draftMigration.includes("ADD COLUMN IF NOT EXISTS ai_reply_draft text"), "draft migration should add reply draft");
assert.ok(draftMigration.includes("ADD COLUMN IF NOT EXISTS ai_draft_goal text"), "draft migration should add draft goal");
assert.ok(campaignMigration.includes("ADD COLUMN IF NOT EXISTS ai_campaign_summary text"), "campaign migration should store AI summary");
assert.ok(publicApp.includes("Ответ разобран ИИ"), "events UI should have Russian AI label");
assert.ok(publicApp.includes("ИИ проверил привязку ответа"), "events UI should have Russian AI thread label");
assert.ok(publicApp.includes("function aiReplyInsightText"), "inbox UI should show AI insight");
assert.ok(publicApp.includes("Черновик ответа от ИИ"), "inbox UI should show AI reply draft");
assert.ok(publicHtml.includes("aiAnalyzeBtn"), "AI export view should have analysis button");
assert.ok(publicApp.includes("renderAiAnalysisResult"), "public UI should render campaign AI analysis");
assert.ok(publicApp.includes("ИИ проанализировал диалоги"), "events UI should label campaign analysis");
assert.ok(publicApp.includes("AI_FUNNEL_LABELS"), "public UI should translate AI funnel labels");
assert.ok(server.includes("ai_next_best_action"), "server exports should include AI next best action");
assert.ok(server.includes("ИИ: вероятно та же цепочка"), "server should expose AI semantic link label");
assert.ok(server.includes("ai_thread_suggested_message_id"), "server should expose AI thread suggestion fields");
assert.ok(server.includes("app.post(\"/api/outreach/conversations/analyze-ai\""), "server should expose campaign AI analysis endpoint");
assert.ok(server.includes("outreach_ai_campaign_analyzed"), "server should log campaign AI analysis");

console.log("OK: AI reply classification stage");
