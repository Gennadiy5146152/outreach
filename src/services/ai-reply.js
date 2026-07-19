import { callYandexGpt, isYandexGptConfigured } from "./yandex-gpt.js";

export const AI_REPLY_CLASSIFICATIONS = new Set([
  "positive_reply",
  "negative_reply",
  "neutral_reply",
  "not_target",
  "auto_reply",
  "bounce",
  "unsubscribe",
  "unknown",
]);

export const AI_FUNNEL_STAGES = new Set([
  "new",
  "opened_unknown",
  "replied_neutral",
  "interested",
  "details_requested",
  "price_requested",
  "meeting_possible",
  "delegated",
  "follow_up_later",
  "not_now",
  "rejected",
  "not_target",
  "unsubscribed",
  "bounced",
  "closed",
]);

export const AI_LEAD_TEMPERATURES = new Set(["hot", "warm", "cold", "bad_fit", "unknown"]);

export const AI_NEXT_BEST_ACTIONS = new Set([
  "reply_manually",
  "send_details",
  "send_price",
  "send_cases",
  "suggest_call",
  "ask_qualifying_question",
  "follow_up_later",
  "stop_sequence",
  "mark_not_target",
  "add_to_suppression",
  "choose_thread",
  "no_action",
]);

function stripMarkdownFences(text) {
  return String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export function safeParseJsonFromAi(text) {
  const stripped = stripMarkdownFences(text);
  try {
    return JSON.parse(stripped);
  } catch (_) {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(stripped.slice(start, end + 1));
      } catch (_) {}
    }
  }
  return null;
}

function normalizeClassification(value, fallback = "unknown") {
  const normalized = String(value || "").trim().toLowerCase();
  return AI_REPLY_CLASSIFICATIONS.has(normalized) ? normalized : fallback;
}

function normalizeFromSet(value, allowed, fallback = "unknown") {
  const normalized = String(value || "").trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function normalizeConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (number > 1 && number <= 100) return Math.max(0, Math.min(1, number / 100));
  return Math.max(0, Math.min(1, number));
}

function compactText(value, limit) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export function buildReplyClassificationPrompt({
  subject = "",
  body = "",
  fallbackClassification = "unknown",
} = {}) {
  return [
    "Ты классификатор ответов на персональный B2B-аутрич.",
    "Нужно определить смысл входящего ответа получателя.",
    "",
    "Верни только JSON одной строкой, без Markdown и пояснений вокруг.",
    "",
    "Допустимые classification:",
    "- positive_reply: интерес, согласие, просьба прислать детали, цена, кейсы, готовность обсудить.",
    "- negative_reply: отказ, не интересно, не актуально, уже не нужно.",
    "- neutral_reply: ответ есть, но явного интереса или отказа нет.",
    "- not_target: ответил не тот человек, не тот отдел, не та компания.",
    "- auto_reply: автоответ, отпуск, out of office, системное уведомление.",
    "- bounce: недоставка или delivery failure.",
    "- unsubscribe: просьба больше не писать или удалить из базы.",
    "- unknown: недостаточно данных или невозможно понять.",
    "",
    "JSON формат:",
    '{"classification":"positive_reply","confidence":0.91,"reason":"короткая причина по-русски","funnel_stage":"details_requested","lead_temperature":"warm","reply_reason":"wants_details","next_best_action":"reply_manually","summary":"краткое резюме"}',
    "",
    "Допустимые funnel_stage:",
    "new, opened_unknown, replied_neutral, interested, details_requested, price_requested, meeting_possible, delegated, follow_up_later, not_now, rejected, not_target, unsubscribed, bounced, closed.",
    "",
    "Допустимые lead_temperature:",
    "hot, warm, cold, bad_fit, unknown.",
    "",
    "Допустимые next_best_action:",
    "reply_manually, send_details, send_price, send_cases, suggest_call, ask_qualifying_question, follow_up_later, stop_sequence, mark_not_target, add_to_suppression, choose_thread, no_action.",
    "",
    `Предварительная классификация системы: ${fallbackClassification}`,
    `Тема: ${compactText(subject, 500)}`,
    "Текст ответа:",
    compactText(body, 4000),
  ].join("\n");
}

export async function analyzeInboundReplyWithAi({
  subject = "",
  body = "",
  fallbackClassification = "unknown",
} = {}) {
  if (!isYandexGptConfigured()) {
    return {
      classification: fallbackClassification,
      source: "auto",
      ai: null,
    };
  }

  try {
    const result = await callYandexGpt({
      prompt: buildReplyClassificationPrompt({ subject, body, fallbackClassification }),
      maxTokens: 180,
      temperature: 0.1,
    });
    const parsed = safeParseJsonFromAi(result.text);
    const aiClassification = normalizeClassification(parsed?.classification, fallbackClassification);
    const confidence = normalizeConfidence(parsed?.confidence);
    const reason = compactText(parsed?.reason, 1000);
    const funnelStage = normalizeFromSet(parsed?.funnel_stage, AI_FUNNEL_STAGES);
    const leadTemperature = normalizeFromSet(parsed?.lead_temperature, AI_LEAD_TEMPERATURES);
    const nextBestAction = normalizeFromSet(parsed?.next_best_action, AI_NEXT_BEST_ACTIONS, "no_action");
    const replyReason = compactText(parsed?.reply_reason, 128) || "unknown";
    const summary = compactText(parsed?.summary, 1000);
    const trusted = confidence == null || confidence >= 0.75 || aiClassification === fallbackClassification;

    return {
      classification: trusted ? aiClassification : fallbackClassification,
      source: trusted ? "ai" : "auto",
      ai: {
        classification: aiClassification,
        confidence,
        reason,
        funnelStage,
        leadTemperature,
        replyReason,
        nextBestAction,
        summary,
        model: result.model,
        usage: result.usage,
        analyzedAt: new Date().toISOString(),
        error: "",
      },
    };
  } catch (error) {
    return {
      classification: fallbackClassification,
      source: "auto",
      ai: {
        classification: null,
        confidence: null,
        reason: "",
        funnelStage: null,
        leadTemperature: null,
        replyReason: "",
        nextBestAction: "",
        summary: "",
        model: "",
        usage: null,
        analyzedAt: new Date().toISOString(),
        error: compactText(error?.message || error, 1000),
      },
    };
  }
}

export function buildThreadMatchPrompt({
  inboundSubject = "",
  inboundBody = "",
  fromEmail = "",
  candidates = [],
} = {}) {
  const compactCandidates = candidates.slice(0, 5).map((candidate, index) => ({
    index: index + 1,
    id: candidate.id,
    subject: compactText(candidate.subject, 300),
    body: compactText(candidate.body_text, 1200),
    sent_at: candidate.sent_at || candidate.created_at || "",
    campaign_id: candidate.campaign_id || "",
    outreach_draft_id: candidate.outreach_draft_id || "",
  }));

  return [
    "Ты помогаешь привязать входящий ответ к одной из исходящих B2B-аутрич цепочек.",
    "Техническая привязка по Message-ID не найдена или слабая, поэтому нужно оценить смысловую близость.",
    "Не угадывай. Если подходящей цепочки нет или есть несколько похожих вариантов, верни suggested_message_id=null.",
    "",
    "Верни только JSON одной строкой, без Markdown и пояснений вокруг.",
    "",
    "JSON формат:",
    '{"suggested_message_id":"uuid или null","confidence":0.86,"reason":"короткая причина по-русски","needs_human_review":false}',
    "",
    `Email отправителя: ${compactText(fromEmail, 200)}`,
    `Тема входящего: ${compactText(inboundSubject, 500)}`,
    "Текст входящего ответа:",
    compactText(inboundBody, 4000),
    "",
    "Возможные исходящие письма:",
    JSON.stringify(compactCandidates),
  ].join("\n");
}

export async function suggestThreadMatchWithAi({
  inboundSubject = "",
  inboundBody = "",
  fromEmail = "",
  candidates = [],
} = {}) {
  if (!isYandexGptConfigured() || !candidates.length) return null;

  try {
    const result = await callYandexGpt({
      prompt: buildThreadMatchPrompt({ inboundSubject, inboundBody, fromEmail, candidates }),
      maxTokens: 180,
      temperature: 0.05,
    });
    const parsed = safeParseJsonFromAi(result.text);
    const suggestedMessageId = String(parsed?.suggested_message_id || "").trim();
    const confidence = normalizeConfidence(parsed?.confidence);
    const reason = compactText(parsed?.reason, 1000);
    const needsHumanReview = Boolean(parsed?.needs_human_review);
    const matchedCandidate = candidates.find((candidate) => candidate.id === suggestedMessageId) || null;

    return {
      suggestedMessageId: matchedCandidate ? matchedCandidate.id : null,
      confidence,
      reason,
      needsHumanReview: needsHumanReview || !matchedCandidate || confidence == null || confidence < 0.85,
      model: result.model,
      usage: result.usage,
      error: "",
    };
  } catch (error) {
    return {
      suggestedMessageId: null,
      confidence: null,
      reason: "",
      needsHumanReview: true,
      model: "",
      usage: null,
      error: compactText(error?.message || error, 1000),
    };
  }
}
