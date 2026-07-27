export function htmlToText(html = "") {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

export function cleanReplyText(text = "") {
  const quoteStartPattern = /^(?:>+\s*)?(?:On .+wrote:|\d{1,2}[./-]\d{1,2}[./-]\d{2,4},?\s+.+\s+(?:wrote|пишет):|(?:Понедельник|Вторник|Среда|Четверг|Пятница|Суббота|Воскресенье),\s+\d{1,2}\s+[а-яё]+\s+\d{4},\s+\d{1,2}:\d{2}.*\s+от\s+.+:)$/i;
  const signatureStartPattern = /^(?:--\s*)?(?:с уважением|with regards|best regards|regards|sent from|отправлено с)/i;
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
  const result = [];

  for (const rawLine of lines) {
    let line = rawLine.trimEnd();
    line = line.replace(/\s+--\s+(?=с уважением|with regards|best regards|regards|sent from|отправлено с).*/i, "");
    line = line.replace(/\s+>{1,}\s*(?:>{1,}\s*)?(?=(?:Понедельник|Вторник|Среда|Четверг|Пятница|Суббота|Воскресенье),\s+\d{1,2}\s+[а-яё]+\s+\d{4},\s+\d{1,2}:\d{2}.*\s+от\s+)/i, "");
    const trimmed = line.trim();
    if (/^[-_]{2,}\s*(original message|forwarded message|исходное сообщение|пересылаемое сообщение)\s*[-_]{2,}$/i.test(trimmed)) break;
    if (quoteStartPattern.test(trimmed)) break;
    if (/^(От|From):\s.+/i.test(trimmed)) break;
    if (/^(Кому|To):\s.+/i.test(trimmed) && result.some((item) => item.trim())) break;
    if (/^(Тема|Subject):\s.+/i.test(trimmed) && result.some((item) => item.trim())) break;
    if (/^>{1,}/.test(trimmed)) break;
    if (/^--\s*$/.test(trimmed)) break;
    if (result.some((item) => item.trim()) && signatureStartPattern.test(trimmed)) break;
    result.push(line);
    if (line !== rawLine.trimEnd()) break;
  }

  const cleaned = result
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned || String(text || "").trim();
}

export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function renderTemplate(template, lead, mailbox, settings = {}) {
  const values = {
    company: lead.company || "",
    contact: lead.contact_name || "коллеги",
    position: lead.position || "",
    website: lead.website || "",
    domain: lead.domain || "",
    segment: lead.segment || "",
    city: lead.city || "",
    pain: lead.pain || "найти больше целевых клиентов",
    offer: settings.senderOffer || "",
    sender: mailbox?.from_name || mailbox?.name || "",
    sender_email: mailbox?.email || "",
  };

  return String(template || "").replace(/\{\{(\w+)}}/g, (_, key) => values[key] ?? "");
}

export function findMissingRequiredVariables(template, lead) {
  const missing = [];
  const variables = [...String(template || "").matchAll(/\{\{(\w+)}}/g)].map((match) => match[1]);
  const required = new Set(["company", "email"]);
  for (const variable of variables) {
    if (!required.has(variable)) continue;
    if (!lead[variable]) missing.push(variable);
  }
  return [...new Set(missing)];
}
