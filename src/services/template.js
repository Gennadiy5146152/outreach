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
    contact: lead.contact_name || "добрый день",
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
  const required = new Set(["company", "contact", "email"]);
  for (const variable of variables) {
    if (!required.has(variable)) continue;
    const field = variable === "contact" ? "contact_name" : variable;
    if (!lead[field]) missing.push(variable);
  }
  return [...new Set(missing)];
}
