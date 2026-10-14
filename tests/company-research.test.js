import assert from "node:assert/strict";
import test from "node:test";

test("strict SMB eligibility excludes public, religious, financial, and large-brand targets", async () => {
  const { researchEligibility, researchPriority } = await import("../src/services/company-research.js");
  assert.deepEqual(researchEligibility({ company: "Ромашка", segment: "cafe" }), {
    status: "needs_size_review",
    reason: "size_unconfirmed",
  });
  assert.deepEqual(researchEligibility({ company: "Большой завод", segment: "крупное производство" }), {
    status: "eligible",
    reason: "factory_or_manufacturer",
  });
  assert.deepEqual(researchEligibility({ company: "Coffee Like", segment: "cafe" }), {
    status: "excluded",
    reason: "large_brand",
  });
  assert.deepEqual(researchEligibility({ company: "Инвитро", segment: "производство" }), {
    status: "excluded",
    reason: "large_brand",
  });
  for (const company of ["ООО «METRO»", "ООО «SPAR»"]) {
    assert.deepEqual(researchEligibility({ company, segment: "малый бизнес" }), {
      status: "excluded",
      reason: "large_brand",
    });
  }
  for (const company of [
    "Министерство промышленности",
    "ГБУ Жилищник",
    "МБУ Ромашка",
    "ФГБУ Центр",
    "ГКУ Центр занятости",
    "МКУ Управление",
    "ФКУ Центр",
    "ГАУ Центр",
    "МАУ Центр",
    "ФГАУ Центр",
    "ФГКУ Центр",
    "ФГБОУ Университет",
    "ГБУЗ Поликлиника",
    "МБОУ Школа",
    "ГУП Сервис",
    "МУП Водоканал",
    "ФГУП Почта",
    "Казённое учреждение",
    "Бюджетное учреждение",
  ]) {
    assert.deepEqual(researchEligibility({ company, segment: "малый бизнес" }), {
      status: "excluded",
      reason: "public_sector",
    });
  }
  assert.deepEqual(researchEligibility({ company: "Храм в честь иконы", segment: "religion" }), {
    status: "excluded",
    reason: "religious_or_noncommercial",
  });
  assert.deepEqual(researchEligibility({ company: "Пример Банк", segment: "bank" }), {
    status: "excluded",
    reason: "finance_or_insurance",
  });
  for (const company of ["Страховая компания Ромашка", "Финансовая компания Ромашка", "Кредитная компания Ромашка", "МФО Ромашка", "ООО «МФО Ромашка»"]) {
    assert.deepEqual(researchEligibility({ company, segment: "малый бизнес" }), {
      status: "excluded",
      reason: "finance_or_insurance",
    });
  }
  assert.deepEqual(researchEligibility({ company: "Неизвестная компания", segment: "" }), {
    status: "needs_size_review",
    reason: "size_unconfirmed",
  });
  assert.deepEqual(researchEligibility({ company: "ООО Неизвестная компания", segment: "company" }), {
    status: "needs_size_review",
    reason: "size_unconfirmed",
  });
  assert.deepEqual(researchPriority({ company: "Альфа", segment: "малый бизнес" }), {
    tier: 1,
    reason: "micro_small_medium",
  });
  assert.deepEqual(researchPriority({ company: "Большой завод", segment: "крупное производство" }), {
    tier: 2,
    reason: "factory_or_manufacturer",
  });
  assert.deepEqual(researchPriority({ company: "Большая сеть", segment: "ритейл" }), {
    tier: 3,
    reason: "other_business",
  });
  assert.deepEqual(researchPriority({ company: "Пример Банк", segment: "банк" }), {
    tier: 4,
    reason: "bank_or_government",
  });
});

test("company key deduplicates website domains and has a stable fallback", async () => {
  const { companyResearchKey } = await import("../src/services/company-research.js");
  assert.equal(companyResearchKey({ website: "https://www.Example.ru/about", company: "A", email: "info@other.ru" }), "domain:example.ru");
  assert.equal(companyResearchKey({ website: "example.ru/contact", company: "B", email: "sales@other.ru" }), "domain:example.ru");
  assert.equal(companyResearchKey({ company: "  ООО Ромашка  ", email: "info@romashka.ru" }), "company:ооо ромашка|romashka.ru");
});

test("source validation allows only public HTTP sources and bounded excerpts", async () => {
  const { validateResearchSource } = await import("../src/services/company-research.js");
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const source = await validateResearchSource({
    url: "https://example.com/page#bio",
    sourceType: "official",
    title: "  О компании  ",
    excerpt: "Подтвержденный публичный факт",
    trustTier: 1,
  }, { lookup: publicLookup });
  assert.equal(source.url, "https://example.com/page");
  assert.equal(source.title, "О компании");
  await assert.rejects(validateResearchSource({ url: "http://127.0.0.1/admin", excerpt: "x" }, { lookup: publicLookup }), /website_url_not_public/);
  await assert.rejects(validateResearchSource({ url: "https://example.com", excerpt: "x".repeat(501) }, { lookup: publicLookup }), /research_source_excerpt_too_long/);
});

test("facts and confirmed contacts require stored evidence and exact public email", async () => {
  const { validateResearchFact, validateResearchContact } = await import("../src/services/company-research.js");
  assert.deepEqual(validateResearchFact({
    sourceId: "source-1",
    factType: "infrastructure",
    text: "Компания развивает облачный сервис",
    evidence: "На официальном сайте описан облачный сервис",
    confidence: 0.9,
    selectedForCopy: true,
  }), {
    sourceId: "source-1",
    factType: "infrastructure",
    text: "Компания развивает облачный сервис",
    evidence: "На официальном сайте описан облачный сервис",
    confidence: 0.9,
    selectedForCopy: true,
  });
  assert.throws(() => validateResearchFact({ text: "Без источника", evidence: "x" }), /research_fact_source_required/);

  const confirmed = validateResearchContact({
    name: "Иван Петров",
    role: "Технический директор",
    email: "ivan@example.com",
    emailStatus: "confirmed",
    sourceId: "source-1",
    evidence: "Технический директор Иван Петров — ivan@example.com",
    confidence: 0.95,
  });
  assert.equal(confirmed.email, "ivan@example.com");
  assert.throws(() => validateResearchContact({
    name: "Иван Петров",
    role: "Технический директор",
    email: "ivan@example.com",
    emailStatus: "confirmed",
    sourceId: "source-1",
    evidence: "Технический директор Иван Петров",
  }), /research_contact_email_not_evidenced/);
  assert.equal(validateResearchContact({
    name: "Иван Петров",
    role: "Технический директор",
    emailStatus: "needs_review",
    sourceId: "source-1",
    evidence: "Технический директор Иван Петров",
  }).email, null);
  const first = validateResearchContact({ name: " Иван  Петров ", role: "Технический директор", emailStatus: "needs_review", sourceId: "source-1", evidence: "Иван Петров — технический директор" });
  const repeated = validateResearchContact({ name: "иван петров", role: "технический директор", emailStatus: "needs_review", sourceId: "source-1", evidence: "Иван Петров — технический директор" });
  assert.equal(first.contactKey, repeated.contactKey);
});

test("draft candidates keep one general recipient and only distinct confirmed executives", async () => {
  const { buildResearchDraftCandidates } = await import("../src/services/company-research.js");
  const base = {
    company: "Альфа",
    generalEmail: "info@alpha.ru",
    facts: [{ text: "На сайте работает личный кабинет", selectedForCopy: true }],
  };
  const candidates = buildResearchDraftCandidates({
    ...base,
    contacts: [
      { id: "contact-1", name: "Иван Петров", role: "Технический директор", email: "ivan@alpha.ru", emailStatus: "confirmed" },
      { id: "contact-2", name: "Анна", role: "CEO", email: "info@alpha.ru", emailStatus: "confirmed" },
      { id: "contact-3", name: "Петр", role: "Коммерческий директор", email: "petr@alpha.ru", emailStatus: "needs_review" },
    ],
  });
  assert.deepEqual(candidates.map((item) => item.audienceKey), ["general", "executive:contact-1"]);
  assert.equal(candidates[0].toEmail, "info@alpha.ru");
  assert.match(candidates[0].bodyText, /Альфа/);
  assert.match(candidates[1].bodyText, /Иван/);
});

test("draft candidates preserve every unique unsent company recipient", async () => {
  const { buildResearchDraftCandidates } = await import("../src/services/company-research.js");
  const candidates = buildResearchDraftCandidates({
    company: "Альфа",
    generalRecipients: [
      { id: "recipient-1", leadId: "lead-1", email: "info@alpha.ru" },
      { id: "recipient-2", leadId: "lead-2", email: "cto@alpha.ru" },
      { id: "recipient-3", leadId: "lead-3", email: "INFO@ALPHA.RU" },
    ],
    facts: [{ text: "На сайте работает личный кабинет", selectedForCopy: true }],
    contacts: [
      { id: "contact-1", name: "Иван Петров", role: "Технический директор", email: "cto@alpha.ru", emailStatus: "confirmed" },
      { id: "contact-2", name: "Анна Смирнова", role: "Коммерческий директор", email: "anna@alpha.ru", emailStatus: "confirmed" },
    ],
  });
  assert.deepEqual(candidates.map((item) => item.audienceKey), [
    "general:recipient-1",
    "general:recipient-2",
    "executive:contact-2",
  ]);
  assert.deepEqual(candidates.slice(0, 2).map((item) => item.recipientId), ["recipient-1", "recipient-2"]);
  assert.deepEqual(candidates.slice(0, 2).map((item) => item.leadId), ["lead-1", "lead-2"]);
});

test("an explicit empty recipient list never falls back to an already contacted address", async () => {
  const { buildResearchDraftCandidates } = await import("../src/services/company-research.js");
  const candidates = buildResearchDraftCandidates({
    company: "Альфа",
    generalEmail: "already-sent@alpha.ru",
    generalRecipients: [],
    facts: [{ text: "Факт", selectedForCopy: true }],
  });
  assert.deepEqual(candidates, []);
});
