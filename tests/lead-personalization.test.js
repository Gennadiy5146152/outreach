import assert from "node:assert/strict";
import test from "node:test";

function validBody() {
  return [
    "Добрый день!",
    "Увидел на сайте компании подтверждённую онлайн-запись: через неё клиенты выбирают услугу и оставляют обращение. Если основной сервер и резервные копии находятся в одной инфраструктуре, при серьёзном сбое одновременно могут стать недоступны и сайт, и связанные данные.",
    "Можем настроить резервирование по правилу 3-2-1: несколько копий на независимых площадках российских провайдеров, регулярные отчёты и проверку восстановления. Это снижает зависимость от одного дата-центра и позволяет восстановить проект из отдельной копии.",
    "Подскажите, актуально ли для вас проверить такую схему сейчас?",
  ].join("\n\n");
}

function validCopy(overrides = {}) {
  const bodyText = validBody();
  assert.ok(bodyText.length >= 300 && bodyText.length <= 700, String(bodyText.length));
  return {
    subject: "Резервные копии для сайта «Альфа»",
    bodyText,
    followupSubject: "Re: Резервные копии для сайта «Альфа»",
    followupBodyText: "Добрый день! Напоминаю о предложении организовать независимые резервные копии сайта. Подскажите, задача сейчас актуальна?",
    usedEvidence: ["process-1"],
    ...overrides,
  };
}

test("qualification deterministically separates qualified, review, excluded, and failed leads", async () => {
  const { qualifyLead } = await import("../src/services/lead-personalization.js");
  const baseLead = { company: "Альфа", segment: "clinic", website: "https://alpha.example" };
  const qualified = qualifyLead({
    lead: baseLead,
    signals: {
      canonicalCompany: "Клиника Альфа",
      pageTextLength: 1200,
      digitalProcesses: [
        { type: "online_appointment", sourceUrl: "https://alpha.example", evidence: "Онлайн-запись" },
        { type: "form", sourceUrl: "https://alpha.example", evidence: "Форма заявки" },
      ],
    },
  });
  assert.equal(qualified.status, "qualified");
  assert.ok(qualified.score >= 60);
  assert.equal(qualified.fact.id, "process-1");
  assert.match(qualified.reason, /цифров/i);

  for (const lead of [
    { company: "Банк Пример", segment: "bank" },
    { company: "Администрация района", segment: "government" },
    { company: "Coffee Like", segment: "cafe" },
    { company: "Храм в честь иконы", segment: "other" },
  ]) {
    const result = qualifyLead({ lead, signals: { canonicalCompany: lead.company, pageTextLength: 1000, digitalProcesses: [] } });
    assert.equal(result.status, "excluded");
  }
  assert.equal(qualifyLead({
    lead: { company: "СДЭК, филиал", segment: "post_office" },
    signals: { canonicalCompany: "СДЭК", isFederalBranch: true, pageTextLength: 1000, digitalProcesses: [{ type: "form" }] },
  }).status, "excluded");
  assert.equal(qualifyLead({
    lead: baseLead,
    signals: { canonicalCompany: "Альфа", pageTextLength: 50, digitalProcesses: [] },
  }).status, "excluded");
  assert.equal(qualifyLead({
    lead: { company: "Мастерская", segment: "craft" },
    signals: { canonicalCompany: "Мастерская", pageTextLength: 900, digitalProcesses: [] },
  }).status, "review");
  assert.equal(qualifyLead({ lead: baseLead, signals: { unavailable: true, digitalProcesses: [] } }).status, "failed");
});

test("contact policy greets only confirmed names and treats a personal mailbox as a review candidate", async () => {
  const { confirmedContact } = await import("../src/services/lead-personalization.js");
  assert.deepEqual(confirmedContact({ lead: { contact_name: "Анна" }, signals: {} }), {
    name: "Анна", position: "", confidence: 1, confirmed: true, source: "lead",
  });
  assert.deepEqual(confirmedContact({
    lead: { email: "info@example.com" },
    signals: { namedContacts: [{ name: "Иван Петров", position: "директор", confidence: 0.95, sourceUrl: "https://example.com/about" }] },
  }), {
    name: "Иван Петров", position: "директор", confidence: 0.95, confirmed: true, source: "website", sourceUrl: "https://example.com/about",
  });
  const candidate = confirmedContact({ lead: { email: "ivan.petrov@example.com" }, signals: { namedContacts: [] } });
  assert.equal(candidate.name, "Ivan Petrov");
  assert.equal(candidate.confirmed, false);
  assert.equal(candidate.confidence, 0.6);
  for (const email of ["info@example.com", "director-344@example.com", "mebelru64_elena@example.com"]) {
    assert.equal(confirmedContact({ lead: { email }, signals: { namedContacts: [] } }), null, email);
  }
});

test("copy validator accepts grounded copy and rejects invented evidence, names, markers, and limits", async () => {
  const { validatePersonalizedCopy } = await import("../src/services/lead-personalization.js");
  const enrichment = {
    contactName: "",
    personalizationFact: "На сайте есть онлайн-запись",
    factSourceUrl: "https://alpha.example",
    factEvidence: "Онлайн-запись",
    evidence: [{ id: "process-1", sourceUrl: "https://alpha.example", evidence: "Онлайн-запись" }],
  };
  assert.deepEqual(validatePersonalizedCopy(validCopy(), enrichment), { ok: true, errors: [] });

  const unsupported = validatePersonalizedCopy(validCopy({ usedEvidence: ["invented"] }), enrichment);
  assert.equal(unsupported.ok, false);
  assert.ok(unsupported.errors.includes("unsupported_evidence"));

  const inventedName = validatePersonalizedCopy(validCopy({ bodyText: validBody().replace("Добрый день!", "Добрый день, Алексей!") }), enrichment);
  assert.ok(inventedName.errors.includes("unconfirmed_contact_name"));
  assert.ok(validatePersonalizedCopy(validCopy({ subject: "{{company}}" }), enrichment).errors.includes("unresolved_marker"));
  assert.ok(validatePersonalizedCopy(validCopy({ bodyText: `${validBody()} ${"длинный текст ".repeat(30)}` }), enrichment).errors.includes("body_length_out_of_range"));
  assert.ok(validatePersonalizedCopy(validCopy({ followupBodyText: "Одно предложение." }), enrichment).errors.includes("followup_sentence_count"));
  assert.ok(validatePersonalizedCopy(validCopy({ bodyText: validBody().replace("?", ".") }), enrichment).errors.includes("closing_question_required"));
});

test("generation requires strict JSON and validates the model response against provided evidence", async () => {
  const { generatePersonalizedCopy } = await import("../src/services/lead-personalization.js");
  const lead = { company: "Альфа", email: "info@alpha.example", city: "Москва", segment: "clinic" };
  const enrichment = {
    canonicalCompany: "Клиника Альфа",
    contactName: "",
    personalizationFact: "На сайте работает онлайн-запись",
    factSourceUrl: "https://alpha.example",
    factEvidence: "Онлайн-запись к врачу",
    evidence: [{ id: "process-1", sourceUrl: "https://alpha.example", evidence: "Онлайн-запись к врачу" }],
  };
  const expected = validCopy();
  const generated = await generatePersonalizedCopy({
    lead,
    enrichment,
    callModel: async (prompt) => {
      assert.match(prompt, /"task":"personalization_copy"/);
      assert.match(prompt, /process-1/);
      assert.doesNotMatch(prompt, /Алексей/);
      return { text: JSON.stringify(expected), model: "test-model" };
    },
  });
  assert.deepEqual(generated, expected);

  await assert.rejects(generatePersonalizedCopy({
    lead,
    enrichment,
    callModel: async () => ({ text: `\`\`\`json\n${JSON.stringify(expected)}\n\`\`\`` }),
  }), /personalization_model_invalid_json/);
  await assert.rejects(generatePersonalizedCopy({
    lead,
    enrichment,
    callModel: async () => ({ text: JSON.stringify(validCopy({ usedEvidence: ["made-up"] })) }),
  }), /personalization_copy_blocked:unsupported_evidence/);
});

test("fallback generation creates valid grounded copy when no language model is configured", async () => {
  const { generateFallbackPersonalizedCopy, validatePersonalizedCopy } = await import("../src/services/lead-personalization.js");
  const lead = { company: "Альфа", email: "info@alpha.example", city: "Самара", segment: "clinic" };
  const enrichment = {
    canonicalCompany: "Клиника Альфа",
    contactName: "",
    personalizationFact: "На сайте работает онлайн-запись",
    factSourceUrl: "https://alpha.example",
    factEvidence: "Онлайн-запись к врачу",
    evidence: [{ id: "process-1", sourceUrl: "https://alpha.example", evidence: "Онлайн-запись к врачу" }],
  };
  const copy = generateFallbackPersonalizedCopy({ lead, enrichment });
  assert.equal(validatePersonalizedCopy(copy, enrichment).ok, true);
  assert.equal(copy.subject, "Резервные копии для сайта «Альфа»");
  assert.match(copy.bodyText, /на вашем сайте работает онлайн-запись/i);
  assert.doesNotMatch(copy.bodyText, /Онлайн-запись к врачу/);
  assert.doesNotMatch(copy.bodyText, /Клиника Альфа/);
  assert.equal(copy.followupBodyText, "Добрый день! Возвращаюсь к вопросу о независимых резервных копиях сайта. Актуальна ли сейчас такая задача? Если нет — больше не буду вас беспокоить.");
  assert.deepEqual(copy.usedEvidence, ["process-1"]);
});

test("fallback generation uses the lead company, strips nested quotes, and never truncates source fragments", async () => {
  const { generateFallbackPersonalizedCopy, validatePersonalizedCopy } = await import("../src/services/lead-personalization.js");
  const contactName = "Иван Иванович Очень-Длинное-Имя-Которое-Нельзя-Искажать";
  const lead = {
    company: "«7 красок»",
    email: "info@example.com",
    city: "Москва",
    segment: "services",
  };
  const enrichment = {
    canonicalCompany: "Главная",
    contactName,
    personalizationFact: "На сайте работает интернет-магазин",
    factSourceUrl: "https://example.com/services",
    factEvidence: "Интернет-магазин. <form class=\"order\"> Подробное техническое описание ".repeat(8),
    evidence: [{
      id: "fact-42",
      sourceUrl: "https://example.com/services",
      evidence: "Интернет-магазин",
    }],
  };
  const copy = generateFallbackPersonalizedCopy({ lead, enrichment });
  const validation = validatePersonalizedCopy(copy, enrichment);
  assert.deepEqual(validation, { ok: true, errors: [] });
  assert.ok(copy.bodyText.length >= 300 && copy.bodyText.length <= 700, String(copy.bodyText.length));
  assert.doesNotMatch(copy.bodyText, /^Добрый день, Иван Иванович Очень-Длинное/);
  assert.equal(copy.subject, "Резервные копии для сайта «7 красок»");
  assert.doesNotMatch(copy.bodyText, /<form|class=|…|Главная/i);
  assert.deepEqual(copy.usedEvidence, ["fact-42"]);
});

test("strict signal detection supports only approved website facts and blocks generic forms", async () => {
  const { detectPersonalizationSignal, generateFallbackPersonalizedCopy } = await import("../src/services/lead-personalization.js");
  const fixtures = [
    ["Записаться онлайн", "online_appointment"],
    ["Онлайн-бронирование номера", "online_booking"],
    ["Вход в личный кабинет", "personal_account"],
    ["Интернет-магазин", "online_store"],
    ["Оформить заказ", "order_form"],
  ];
  for (const [evidence, type] of fixtures) assert.equal(detectPersonalizationSignal(evidence)?.type, type);
  assert.equal(detectPersonalizationSignal("Форма обратной связи"), null);
  assert.throws(() => generateFallbackPersonalizedCopy({
    lead: { company: "Альфа" },
    enrichment: {
      personalizationFact: "На сайте есть форма",
      factSourceUrl: "https://alpha.example",
      factEvidence: "Форма обратной связи",
      evidence: [{ id: "process-1" }],
    },
  }), /personalization_signal_not_approved/);
});
