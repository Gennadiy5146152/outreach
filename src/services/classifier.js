const positive = ["интерес", "актуально", "давайте", "созвон", "встреч", "подробнее", "пришлите", "расскажите"];
const negative = ["не интересно", "неактуально", "не актуально", "не нужно", "откаж", "нет потребности"];
const unsubscribe = ["не пишите", "отпишите", "unsubscribe", "удалите", "не присылайте"];
const autoReply = ["out of office", "автоответ", "automatic reply", "в отпуске", "absence"];
const bounce = ["undelivered", "delivery status notification", "mail delivery failed", "недостав"];

export function classifyInbound({ subject = "", body = "", headers = {} }) {
  const text = `${subject}\n${body}\n${JSON.stringify(headers)}`.toLowerCase();
  if (bounce.some((item) => text.includes(item))) return "bounce";
  if (unsubscribe.some((item) => text.includes(item))) return "unsubscribe";
  if (autoReply.some((item) => text.includes(item))) return "auto_reply";
  if (positive.some((item) => text.includes(item))) return "positive_reply";
  if (negative.some((item) => text.includes(item))) return "negative_reply";
  if (text.trim()) return "neutral_reply";
  return "unknown";
}
