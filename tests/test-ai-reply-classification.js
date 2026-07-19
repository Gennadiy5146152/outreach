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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = fs.readFileSync(path.join(root, "src/worker/index.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "db/migrations/006_ai_reply_analysis.sql"), "utf8");
const publicApp = fs.readFileSync(path.join(root, "public/app.js"), "utf8");

assert.ok(worker.includes("analyzeInboundReplyWithAi"), "worker should call AI reply analysis");
assert.ok(worker.includes("inbound_ai_classified"), "worker should log AI classification event");
assert.ok(worker.includes("ai_classification, ai_confidence, ai_reason"), "worker should insert AI columns");
assert.ok(migration.includes("ADD COLUMN IF NOT EXISTS ai_classification text"), "migration should add ai_classification");
assert.ok(migration.includes("ADD COLUMN IF NOT EXISTS ai_confidence numeric"), "migration should add ai_confidence");
assert.ok(publicApp.includes("Ответ разобран ИИ"), "events UI should have Russian AI label");
assert.ok(publicApp.includes("function aiReplyInsightText"), "inbox UI should show AI insight");

console.log("OK: AI reply classification stage");
