import assert from "node:assert/strict";
import test from "node:test";

test("priority ranks every company without hard-excluding banks or government", async () => {
  const { researchPriority } = await import("../src/services/company-research.js");
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

