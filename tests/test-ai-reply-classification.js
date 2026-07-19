import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.YANDEX_GPT_MOCK = "1";

const { analyzeInboundReplyWithAi, buildReplyClassificationPrompt, safeParseJsonFromAi } = await import("../src/services/ai-reply.js");

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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = fs.readFileSync(path.join(root, "src/worker/index.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "db/migrations/006_ai_reply_analysis.sql"), "utf8");
const funnelMigration = fs.readFileSync(path.join(root, "db/migrations/007_ai_funnel_insights.sql"), "utf8");
const publicApp = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const server = fs.readFileSync(path.join(root, "src/server.js"), "utf8");

assert.ok(worker.includes("analyzeInboundReplyWithAi"), "worker should call AI reply analysis");
assert.ok(worker.includes("inbound_ai_classified"), "worker should log AI classification event");
assert.ok(worker.includes("ai_classification, ai_confidence, ai_reason"), "worker should insert AI columns");
assert.ok(worker.includes("ai_funnel_stage, ai_lead_temperature, ai_reply_reason"), "worker should insert AI funnel columns");
assert.ok(worker.includes("applyAiConversationInsights"), "worker should copy AI insights to conversations");
assert.ok(migration.includes("ADD COLUMN IF NOT EXISTS ai_classification text"), "migration should add ai_classification");
assert.ok(migration.includes("ADD COLUMN IF NOT EXISTS ai_confidence numeric"), "migration should add ai_confidence");
assert.ok(funnelMigration.includes("ADD COLUMN IF NOT EXISTS ai_funnel_stage text"), "funnel migration should add message funnel stage");
assert.ok(funnelMigration.includes("ADD COLUMN IF NOT EXISTS lead_temperature text"), "funnel migration should add conversation lead temperature");
assert.ok(publicApp.includes("Ответ разобран ИИ"), "events UI should have Russian AI label");
assert.ok(publicApp.includes("function aiReplyInsightText"), "inbox UI should show AI insight");
assert.ok(publicApp.includes("AI_FUNNEL_LABELS"), "public UI should translate AI funnel labels");
assert.ok(server.includes("ai_next_best_action"), "server exports should include AI next best action");

console.log("OK: AI reply classification stage");
