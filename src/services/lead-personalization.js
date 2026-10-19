import { callYandexGpt, isYandexGptConfigured } from "./yandex-gpt.js";
import { researchEligibility } from "./company-research.js";

const EXCLUDED_SEGMENTS = new Set([
  "bank",
  "banking",
  "government",
  "government_agency",
  "state",
  "public_authority",
]);

const GENERIC_MAILBOXES = new Set([
  "admin",
  "contact",
  "director",
  "hello",
  "info",
  "mail",
  "office",
  "sales",
  "support",
  "team",
]);

const NUMBERED_FOLLOWUP = "Добрый день! Возвращаюсь к вопросу о независимых резервных копиях сайта. Чтобы я правильно закрыл вопрос, ответьте одной цифрой: 1 — актуально, можно обсудить; 2 — вернуться через несколько месяцев; 3 — неактуально, больше не писать. Если выберете 2, напишите примерный месяц :)";

function clean(value) {
  return String(value || "").trim();
}

const PERSONALIZATION_SIGNALS = [
  {
    type: "online_appointment",
    pattern: /(?:онлайн[\s-]*запис|запис(?:аться|ь)?\s+онлайн)/iu,
    clause: "работает онлайн-запись",
    dataSentence: "Такие функции обычно связаны с клиентскими данными, поэтому при сбое важно иметь независимую копию сайта и базы данных.",
  },
  {
    type: "online_booking",
    pattern: /(?:онлайн[\s-]*бронирован|забронировать|бронирование\s+онлайн)/iu,
    clause: "доступно онлайн-бронирование",
    dataSentence: "Такие функции обычно связаны с клиентскими данными, поэтому при сбое важно иметь независимую копию сайта и базы данных.",
  },
  {
    type: "personal_account",
    pattern: /личн(?:ый|ого|ом|ым)\s+кабинет/iu,
    clause: "доступен личный кабинет",
    dataSentence: "Личный кабинет обычно связан с клиентскими данными, поэтому при сбое важно иметь независимую копию сайта и базы данных.",
  },
  {
    type: "online_store",
    pattern: /(?:интернет[\s-]*магазин|добавить\s+в\s+корзину)/iu,
    clause: "работает интернет-магазин",
    dataSentence: "Заказы и клиентские данные зависят от доступности сайта, поэтому при сбое важно иметь независимую копию сайта и базы данных.",
  },
  {
    type: "order_form",
    pattern: /(?:оформить\s+заказ|форма\s+заказа|сделать\s+заказ)/iu,
    clause: "работает форма заказа",
    dataSentence: "Заказы и клиентские данные зависят от доступности сайта, поэтому при сбое важно иметь независимую копию сайта и базы данных.",
  },
];

export function detectPersonalizationSignal(value) {
  const evidence = clean(value);
  if (!evidence) return null;
  const signal = PERSONALIZATION_SIGNALS.find((candidate) => candidate.pattern.test(evidence));
  return signal ? { type: signal.type, clause: signal.clause, dataSentence: signal.dataSentence } : null;
}

function normalizedFact(process, index) {
  if (!process || typeof process !== "object") return null;
  const sourceUrl = clean(process.sourceUrl);
  const evidence = clean(process.evidence);
  if (!sourceUrl || !evidence) return null;
  return {
    id: clean(process.id) || `process-${index + 1}`,
    type: clean(process.type),
    sourceUrl,
    evidence,
  };
}

export function qualifyLead({ lead = {}, signals = {} } = {}) {
  if (signals.unavailable) {
    return { status: "failed", score: 0, reason: "Сайт недоступен для проверки.", fact: null };
  }

  const segment = clean(lead.segment).toLowerCase();
  const company = `${clean(lead.company)} ${clean(signals.canonicalCompany)}`.toLowerCase();
  const targetDecision = researchEligibility({
    ...lead,
    company,
    businessType: signals.businessType,
  });
  if (
    targetDecision.status === "excluded" ||
    EXCLUDED_SEGMENTS.has(segment) ||
    signals.isFederalBranch === true ||
    /(?:^|\s)(?:банк|администраци|министерств|ведомств|госучрежден|филиал\s+(?:сдэк|почт))/iu.test(company)
  ) {
    return { status: "excluded", score: 0, reason: "Компания не входит в целевой сегмент пилота.", fact: null };
  }

  const pageTextLength = Number(signals.pageTextLength || 0);
  if (pageTextLength > 0 && pageTextLength < 200) {
    return { status: "excluded", score: 5, reason: "На сайте недостаточно данных для безопасной персонализации.", fact: null };
  }

  const facts = (Array.isArray(signals.digitalProcesses) ? signals.digitalProcesses : [])
    .map(normalizedFact)
    .filter((fact) => fact && detectPersonalizationSignal(fact.evidence));
  if (!facts.length) {
    return { status: "review", score: 30, reason: "Цифровой процесс на сайте не подтверждён; нужна ручная проверка.", fact: null };
  }

  const score = Math.min(100, 45 + facts.length * 15 + (pageTextLength >= 500 ? 5 : 0));
  return {
    status: score >= 60 ? "qualified" : "review",
    score,
    reason: "На сайте подтверждён цифровой процесс, связанный с клиентскими или операционными данными.",
    fact: facts[0],
  };
}

function titleCaseLatinName(value) {
  return value
    .split(".")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

export function confirmedContact({ lead = {}, signals = {} } = {}) {
  const leadName = clean(lead.contact_name || lead.contactName);
  if (leadName) {
    return {
      name: leadName,
      position: clean(lead.contact_position || lead.contactPosition),
      confidence: 1,
      confirmed: true,
      source: "lead",
    };
  }

  const websiteContact = (Array.isArray(signals.namedContacts) ? signals.namedContacts : [])
    .find((contact) => clean(contact?.name) && Number(contact?.confidence) >= 0.9 && clean(contact?.sourceUrl));
  if (websiteContact) {
    return {
      name: clean(websiteContact.name),
      position: clean(websiteContact.position),
      confidence: Number(websiteContact.confidence),
      confirmed: true,
      source: "website",
      sourceUrl: clean(websiteContact.sourceUrl),
    };
  }

  const localPart = clean(lead.email).split("@")[0].toLowerCase();
  if (!localPart || GENERIC_MAILBOXES.has(localPart)) return null;
  if (!/^[a-z]{2,20}\.[a-z]{2,30}$/.test(localPart)) return null;
  return {
    name: titleCaseLatinName(localPart),
    position: "",
    confidence: 0.6,
    confirmed: false,
    source: "email_candidate",
  };
}

function sentenceCount(value) {
  return (clean(value).match(/[.!?](?=\s|$)/g) || []).length;
}

function containsMarker(value) {
  return /\{\{[^}]*\}\}|\[\[[^\]]*\]\]|<<[^>]*>>/.test(String(value || ""));
}

export function validatePersonalizedCopy(copy = {}, enrichment = {}) {
  const errors = [];
  const subject = clean(copy.subject);
  const bodyText = clean(copy.bodyText);
  const followupSubject = clean(copy.followupSubject);
  const followupBodyText = clean(copy.followupBodyText);
  const allText = [subject, bodyText, followupSubject, followupBodyText].join("\n");

  if (!subject || !bodyText || !followupSubject || !followupBodyText) errors.push("required_copy_field_missing");
  if (bodyText.length < 300 || bodyText.length > 700) errors.push("body_length_out_of_range");
  const followupSentences = sentenceCount(followupBodyText);
  if (followupSentences < 3 || followupSentences > 4) errors.push("followup_sentence_count");
  if (!/1\s*[—-]\s*актуально[\s\S]*2\s*[—-]\s*вернуться[\s\S]*3\s*[—-]\s*неактуально/iu.test(followupBodyText)) {
    errors.push("numbered_followup_required");
  }
  if (containsMarker(allText)) errors.push("unresolved_marker");

  const questionCount = (bodyText.match(/\?/g) || []).length;
  if (questionCount !== 1 || !bodyText.endsWith("?")) errors.push("closing_question_required");

  const confirmedName = clean(enrichment.contactName);
  const namedGreeting = bodyText.match(/^\s*Добрый день,\s*([^!\n]+)!/iu);
  if (namedGreeting && (!confirmedName || clean(namedGreeting[1]).toLowerCase() !== confirmedName.toLowerCase())) {
    errors.push("unconfirmed_contact_name");
  }

  const allowedEvidence = new Set(
    (Array.isArray(enrichment.evidence) ? enrichment.evidence : [])
      .map((item) => clean(item?.id))
      .filter(Boolean),
  );
  const usedEvidence = Array.isArray(copy.usedEvidence) ? copy.usedEvidence.map(clean).filter(Boolean) : [];
  if (!usedEvidence.length || usedEvidence.some((id) => !allowedEvidence.has(id))) errors.push("unsupported_evidence");

  if (!clean(enrichment.personalizationFact) || !clean(enrichment.factSourceUrl) || !clean(enrichment.factEvidence)) {
    errors.push("personalization_fact_incomplete");
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

function personalizationPrompt(lead, enrichment) {
  const confirmedName = clean(enrichment.contactName);
  return JSON.stringify({
    task: "personalization_copy",
    language: "ru",
    constraints: {
      output: "strict_json_only",
      subject: "конкретная тема без кликбейта",
      bodyLength: "300-700 characters",
      followupSentences: "3-4",
      followupResponseOptions: "Обязательно предложить ответ одной цифрой: 1 — актуально, можно обсудить; 2 — вернуться через несколько месяцев; 3 — неактуально, больше не писать. Для варианта 2 попросить указать примерный месяц.",
      closingQuestions: 1,
      greeting: confirmedName ? `Добрый день, ${confirmedName}!` : "Добрый день!",
      noInventedFacts: true,
    },
    lead: {
      company: clean(lead.company),
      city: clean(lead.city),
      segment: clean(lead.segment),
      contactName: confirmedName,
    },
    personalization: {
      fact: clean(enrichment.personalizationFact),
      sourceUrl: clean(enrichment.factSourceUrl),
      evidence: clean(enrichment.factEvidence),
    },
    allowedEvidence: (Array.isArray(enrichment.evidence) ? enrichment.evidence : []).map((item) => ({
      id: clean(item?.id),
      sourceUrl: clean(item?.sourceUrl),
      evidence: clean(item?.evidence),
    })),
    responseSchema: {
      subject: "string",
      bodyText: "string",
      followupSubject: "string",
      followupBodyText: "string",
      usedEvidence: ["allowedEvidence.id"],
    },
  });
}

function safeCompanyName(value) {
  const company = clean(value)
    .replace(/&(?:laquo|raquo|quot|amp);/giu, " ")
    .replace(/[<>{}\[\]«»„“”‟‹›"]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!company || company.length > 100) throw new Error("personalization_company_name_not_safe");
  return company;
}

export function generateFallbackPersonalizedCopy({ lead = {}, enrichment = {} } = {}) {
  const company = safeCompanyName(lead.company);
  const signal = detectPersonalizationSignal(enrichment.factEvidence || enrichment.personalizationFact);
  if (!signal) throw new Error("personalization_signal_not_approved");
  const rawContactName = clean(enrichment.contactName);
  const contactName = rawContactName.length <= 40 ? rawContactName.replace(/[?{}<>\[\]]/g, "").trim() : "";
  const greeting = contactName ? `Добрый день, ${contactName}!` : "Добрый день!";
  const subject = `Резервные копии для сайта «${company}»`;
  const bodyText = [
    greeting,
    `Увидел, что на вашем сайте ${signal.clause}. ${signal.dataSentence}`,
    "Мы можем организовать хранение по правилу 3-2-1: несколько копий, независимые российские хостинги, шифрование и регулярная проверка восстановления.",
    "Подскажите, актуальна ли для вас такая задача?",
  ].join("\n\n");
  const evidenceId = (Array.isArray(enrichment.evidence) ? enrichment.evidence : [])
    .map((item) => clean(item?.id))
    .find(Boolean) || "process-1";
  return {
    subject,
    bodyText,
    followupSubject: `Re: ${subject}`,
    followupBodyText: NUMBERED_FOLLOWUP,
    usedEvidence: [evidenceId],
  };
}

export async function generatePersonalizedCopy({
  lead = {},
  enrichment = {},
  callModel = null,
} = {}) {
  if (!callModel && !isYandexGptConfigured()) {
    const copy = generateFallbackPersonalizedCopy({ lead, enrichment });
    const validation = validatePersonalizedCopy(copy, enrichment);
    if (!validation.ok) throw new Error(`personalization_copy_blocked:${validation.errors.join(",")}`);
    return copy;
  }
  const prompt = personalizationPrompt(lead, enrichment);
  const response = await (callModel || ((value) => callYandexGpt({ prompt: value, maxTokens: 1200, temperature: 0.2 })))(prompt);
  const raw = typeof response === "string" ? response : response?.text;
  let copy;
  try {
    copy = JSON.parse(String(raw || ""));
  } catch {
    throw new Error("personalization_model_invalid_json");
  }
  if (!copy || typeof copy !== "object" || Array.isArray(copy)) {
    throw new Error("personalization_model_invalid_json");
  }
  const validation = validatePersonalizedCopy(copy, enrichment);
  if (!validation.ok) throw new Error(`personalization_copy_blocked:${validation.errors.join(",")}`);
  return copy;
}
