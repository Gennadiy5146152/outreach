import { assertPublicHttpUrl, normalizeWebsiteUrl } from "./website-enrichment.js";

export const COMPANY_RESEARCH_RULES_VERSION = "company-research-v1";
export const MAX_RESEARCH_SOURCES = 10;

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function boundedText(value, field, max = 500, { required = true } = {}) {
  const text = clean(value);
  if (required && !text) throw new Error(`${field}_required`);
  if (text.length > max) throw new Error(`${field}_too_long`);
  return text;
}

function normalizedEmail(value) {
  const email = clean(value).toLowerCase();
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("research_contact_email_invalid");
  return email;
}

function emailDomain(value) {
  return normalizedEmail(value)?.split("@")[1] || "unknown";
}

export function researchPriority(lead = {}) {
  const haystack = `${clean(lead.company)} ${clean(lead.segment)} ${clean(lead.businessType)}`.toLowerCase();
  if (/(?:^|[^а-яёa-z0-9])(?:микро|мал(?:ый|ое)|средн(?:ий|ее)|мсп|ип)(?=$|[^а-яёa-z0-9])/iu.test(haystack)) {
    return { tier: 1, reason: "micro_small_medium" };
  }
  if (/завод|фабрик|производ|manufactur|промышлен/iu.test(haystack)) {
    return { tier: 2, reason: "factory_or_manufacturer" };
  }
  if (/банк|банков|министер|ведомств|администрац|государств|муниципал/iu.test(haystack)) {
    return { tier: 4, reason: "bank_or_government" };
  }
  return { tier: 3, reason: "other_business" };
}

export function companyResearchKey(lead = {}) {
  const website = clean(lead.website);
  if (website) {
    try {
      const hostname = normalizeWebsiteUrl(website).hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
      if (hostname) return `domain:${hostname}`;
    } catch {
      // Fall back to company and email domain for malformed historical URLs.
    }
  }
  const company = clean(lead.company).toLowerCase();
  if (!company) throw new Error("research_company_identity_required");
  return `company:${company}|${emailDomain(lead.email)}`;
}

export async function validateResearchSource(input = {}, { lookup } = {}) {
  const target = normalizeWebsiteUrl(input.url);
  await assertPublicHttpUrl(target, lookup ? { lookup } : {});
  target.hash = "";
  const excerpt = boundedText(input.excerpt, "research_source_excerpt", 500, { required: false });
  const trustTier = Number(input.trustTier || 5);
  if (!Number.isInteger(trustTier) || trustTier < 1 || trustTier > 5) throw new Error("research_source_trust_invalid");
  return {
    sourceKey: clean(input.sourceKey) || null,
    url: target.href,
    sourceType: boundedText(input.sourceType || "other", "research_source_type", 80),
    title: boundedText(input.title, "research_source_title", 300, { required: false }),
    publisher: boundedText(input.publisher, "research_source_publisher", 200, { required: false }),
    publishedAt: clean(input.publishedAt) || null,
    excerpt,
    trustTier,
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? input.metadata : {},
  };
}

export function validateResearchFact(input = {}) {
  const sourceId = clean(input.sourceId || input.sourceKey);
  if (!sourceId) throw new Error("research_fact_source_required");
  const confidence = Number(input.confidence ?? 0.5);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("research_fact_confidence_invalid");
  return {
    sourceId,
    factType: boundedText(input.factType || "other", "research_fact_type", 80),
    text: boundedText(input.text, "research_fact_text", 500),
    evidence: boundedText(input.evidence, "research_fact_evidence", 500),
    confidence,
    selectedForCopy: Boolean(input.selectedForCopy),
  };
}

export function validateResearchContact(input = {}) {
  const sourceId = clean(input.sourceId || input.sourceKey);
  if (!sourceId) throw new Error("research_contact_source_required");
  const emailStatus = clean(input.emailStatus || "needs_review");
  if (!["confirmed", "needs_review", "rejected"].includes(emailStatus)) throw new Error("research_contact_status_invalid");
  const email = normalizedEmail(input.email);
  const name = boundedText(input.name, "research_contact_name", 200, { required: false });
  const role = boundedText(input.role, "research_contact_role", 200, { required: false });
  if (!email && !name && !role) throw new Error("research_contact_identity_required");
  const contactKey = email
    ? `email:${email}`
    : `person:${name.toLowerCase()}|${role.toLowerCase()}`;
  const evidence = boundedText(input.evidence, "research_contact_evidence", 500);
  if (emailStatus === "confirmed" && !email) throw new Error("research_contact_confirmed_email_required");
  if (emailStatus === "confirmed" && !evidence.toLowerCase().includes(email)) {
    throw new Error("research_contact_email_not_evidenced");
  }
  const confidence = Number(input.confidence ?? 0.5);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("research_contact_confidence_invalid");
  return {
    sourceId,
    contactKey,
    name,
    role,
    email,
    emailStatus,
    confidence,
    evidence,
  };
}

function backupCopy({ company, greeting, fact }) {
  const factLine = fact ? `\n\nОбратил внимание: ${fact}.` : "";
  return `${greeting}\n\nИз-за последних атак на дата-центры часть компаний столкнулась с потерей данных и даже резервных копий.\n\nМы можем организовать для сайта ${company} хранение бэкапов по правилу 3-2-1: несколько копий, разные носители и одна копия вне основной инфраструктуры.${factLine}\n\nЕсли основной хостинг станет недоступен, данные можно будет восстановить из другой независимой копии.\n\nМожем организовать такую схему для вашего сайта.\n\nС уважением,\nГеннадий Коротков`;
}

export function buildResearchDraftCandidates({ company, generalEmail, facts = [], contacts = [] } = {}) {
  const normalizedGeneral = normalizedEmail(generalEmail);
  if (!normalizedGeneral) return [];
  const companyName = clean(company) || "вашей компании";
  const fact = facts.find((item) => item?.selectedForCopy)?.text || facts[0]?.text || "";
  const subject = "Как защитить данные сайта и резервные копии";
  const followupSubject = "Re: как защитить данные сайта и резервные копии";
  const followupBodyText = "Добрый день! Напоминаю о предложении организовать резервное хранение данных вашего сайта по принципу 3-2-1. Подскажите, это актуально? Если нет, больше не буду вас беспокоить.";
  const candidates = [{
    audienceKey: "general",
    audienceType: "general",
    contactId: null,
    toEmail: normalizedGeneral,
    contactName: "",
    subject,
    bodyText: backupCopy({ company: companyName, greeting: "Добрый день!", fact }),
    followupSubject,
    followupBodyText,
  }];
  const seen = new Set([normalizedGeneral]);
  for (const contact of contacts) {
    const email = normalizedEmail(contact?.email);
    if (contact?.emailStatus !== "confirmed" || !email || seen.has(email)) continue;
    seen.add(email);
    const firstName = clean(contact.name).split(" ")[0];
    candidates.push({
      audienceKey: `executive:${contact.id}`,
      audienceType: "executive",
      contactId: contact.id,
      toEmail: email,
      contactName: clean(contact.name),
      subject,
      bodyText: backupCopy({ company: companyName, greeting: firstName ? `${firstName}, добрый день!` : "Добрый день!", fact }),
      followupSubject,
      followupBodyText,
    });
  }
  return candidates;
}

async function transaction(client, operation) {
  await client.query("BEGIN");
  try {
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function createResearchRuns(client, { leads = [], rulesVersion = COMPANY_RESEARCH_RULES_VERSION } = {}) {
  const unique = new Map();
  for (const lead of leads) {
    const companyKey = companyResearchKey(lead);
    if (!unique.has(companyKey)) unique.set(companyKey, lead);
  }
  return transaction(client, async () => {
    let created = 0;
    const ids = [];
    for (const [companyKey, lead] of unique) {
      const priority = researchPriority(lead);
      const result = await client.query(
        `
          INSERT INTO company_research_runs(lead_id, company_key, rules_version, priority_tier, priority_reason)
          VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (company_key, rules_version) DO NOTHING
          RETURNING id
        `,
        [lead.id, companyKey, rulesVersion, priority.tier, priority.reason],
      );
      created += result.rowCount || 0;
      if (result.rows[0]?.id) ids.push(result.rows[0].id);
    }
    return { created, existing: unique.size - created, selected: unique.size, ids };
  });
}

export async function claimResearchRun(client, { workerId, leaseMinutes = 15 } = {}) {
  const owner = boundedText(workerId, "research_worker", 200);
  const minutes = Math.min(Math.max(Math.trunc(Number(leaseMinutes || 15)), 1), 60);
  const result = await client.query(
    `
      WITH next_run AS (
        SELECT id
        FROM company_research_runs
        WHERE status = 'queued'
           OR (status = 'researching' AND lease_expires_at <= now())
        ORDER BY priority_tier, created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE company_research_runs AS run
      SET status = 'researching', claimed_by = $1,
          lease_expires_at = now() + ($2::int * interval '1 minute'),
          attempt_count = attempt_count + 1, last_error = NULL, updated_at = now()
      FROM next_run
      WHERE run.id = next_run.id
      RETURNING run.*
    `,
    [owner, minutes],
  );
  return result.rows[0] || null;
}

function sourceReference(value, sourceIds) {
  return sourceIds.get(value) || value;
}

export async function saveResearchBundle(client, {
  runId,
  workerId,
  sources = [],
  facts = [],
  contacts = [],
  validateUrl = validateResearchSource,
} = {}) {
  const sourcesByUrl = new Map();
  for (const source of sources) {
    const validated = await validateUrl(source);
    const existing = sourcesByUrl.get(validated.url);
    if (existing) {
      if (validated.sourceKey) existing.sourceKeys.add(validated.sourceKey);
      continue;
    }
    sourcesByUrl.set(validated.url, {
      ...validated,
      sourceKeys: new Set(validated.sourceKey ? [validated.sourceKey] : []),
    });
  }
  const safeSources = [...sourcesByUrl.values()];
  const safeFacts = facts.map(validateResearchFact);
  const safeContacts = contacts.map(validateResearchContact);
  return transaction(client, async () => {
    const run = (await client.query(
      `
        SELECT run.id,
               COALESCE((
                 SELECT array_agg(canonical_url ORDER BY canonical_url)
                 FROM company_research_sources
                 WHERE research_run_id = run.id
               ), ARRAY[]::text[]) AS source_urls
        FROM company_research_runs run
        WHERE run.id = $1 AND run.status = 'researching'
          AND run.claimed_by = $2 AND run.lease_expires_at > now()
        FOR UPDATE OF run
      `,
      [runId, workerId],
    )).rows[0];
    if (!run) throw new Error("research_claim_invalid_or_expired");
    const existingUrls = new Set(run.source_urls || []);
    const newSourceCount = safeSources.filter((source) => !existingUrls.has(source.url)).length;
    if (existingUrls.size + newSourceCount > MAX_RESEARCH_SOURCES) {
      throw new Error("research_source_limit_exceeded");
    }
    const sourceIds = new Map();
    for (const source of safeSources) {
      const inserted = (await client.query(
        `
          INSERT INTO company_research_sources(
            research_run_id, canonical_url, source_type, title, publisher,
            published_at, excerpt, trust_tier, metadata
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
          ON CONFLICT (research_run_id, canonical_url) DO UPDATE SET
            source_type = EXCLUDED.source_type, title = EXCLUDED.title,
            publisher = EXCLUDED.publisher, published_at = EXCLUDED.published_at,
            excerpt = EXCLUDED.excerpt, trust_tier = EXCLUDED.trust_tier,
            metadata = EXCLUDED.metadata, updated_at = now()
          RETURNING id
        `,
        [runId, source.url, source.sourceType, source.title, source.publisher, source.publishedAt, source.excerpt, source.trustTier, JSON.stringify(source.metadata)],
      )).rows[0];
      for (const sourceKey of source.sourceKeys) sourceIds.set(sourceKey, inserted.id);
      sourceIds.set(source.url, inserted.id);
    }
    for (const fact of safeFacts) {
      const sourceId = sourceReference(fact.sourceId, sourceIds);
      const result = await client.query(
        `
          INSERT INTO company_research_facts(research_run_id, source_id, fact_type, fact_text, evidence, confidence, selected_for_copy)
          SELECT $1,$2,$3,$4,$5,$6,$7
          WHERE EXISTS (SELECT 1 FROM company_research_sources WHERE id = $2 AND research_run_id = $1)
          ON CONFLICT (research_run_id, source_id, fact_text) DO UPDATE SET
            evidence = EXCLUDED.evidence, confidence = EXCLUDED.confidence,
            selected_for_copy = EXCLUDED.selected_for_copy, updated_at = now()
          RETURNING id
        `,
        [runId, sourceId, fact.factType, fact.text, fact.evidence, fact.confidence, fact.selectedForCopy],
      );
      if (!result.rowCount) throw new Error("research_fact_source_not_found");
    }
    for (const contact of safeContacts) {
      const sourceId = sourceReference(contact.sourceId, sourceIds);
      const result = await client.query(
        `
          INSERT INTO company_contacts(research_run_id, source_id, contact_key, name, role, email, normalized_email, email_status, confidence, evidence)
          SELECT $1,$2,$3,$4,$5,$6,$6,$7,$8,$9
          WHERE EXISTS (SELECT 1 FROM company_research_sources WHERE id = $2 AND research_run_id = $1)
          ON CONFLICT (research_run_id, contact_key) DO UPDATE SET
            source_id = EXCLUDED.source_id, name = EXCLUDED.name, role = EXCLUDED.role,
            email = EXCLUDED.email, normalized_email = EXCLUDED.normalized_email,
            email_status = EXCLUDED.email_status, confidence = EXCLUDED.confidence,
            evidence = EXCLUDED.evidence, updated_at = now()
          RETURNING id
        `,
        [runId, sourceId, contact.contactKey, contact.name, contact.role, contact.email, contact.emailStatus, contact.confidence, contact.evidence],
      );
      if (!result.rowCount) throw new Error("research_contact_source_not_found");
    }
    return { sources: safeSources.length, facts: safeFacts.length, contacts: safeContacts.length };
  });
}

export async function completeResearchRun(client, { runId, workerId, status = "ready", error = "" } = {}) {
  if (!["ready", "review", "failed"].includes(status)) throw new Error("research_completion_status_invalid");
  return transaction(client, async () => {
    const run = (await client.query(
      `
        SELECT run.*, lead.company, lead.email AS general_email
        FROM company_research_runs run
        JOIN leads lead ON lead.id = run.lead_id
        WHERE run.id = $1 AND run.status = 'researching'
          AND run.claimed_by = $2 AND run.lease_expires_at > now()
        FOR UPDATE OF run
      `,
      [runId, workerId],
    )).rows[0];
    if (!run) throw new Error("research_claim_invalid_or_expired");
    const facts = (await client.query(
      "SELECT id, fact_text AS text, selected_for_copy FROM company_research_facts WHERE research_run_id = $1 ORDER BY selected_for_copy DESC, confidence DESC",
      [runId],
    )).rows;
    const contacts = (await client.query(
      "SELECT id, name, role, email, email_status AS \"emailStatus\" FROM company_contacts WHERE research_run_id = $1 ORDER BY confidence DESC",
      [runId],
    )).rows;
    let finalStatus = status;
    if (status === "ready" && !facts.length) finalStatus = "review";
    if (finalStatus !== "failed") {
      const candidates = buildResearchDraftCandidates({ company: run.company, generalEmail: run.general_email, facts, contacts });
      for (const candidate of candidates) {
        await client.query(
          `
            INSERT INTO company_research_drafts(
              research_run_id, contact_id, audience_key, audience_type, to_email,
              contact_name, subject, body_text, followup_subject, followup_body_text
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (research_run_id, audience_key) DO UPDATE SET
              to_email = EXCLUDED.to_email, contact_name = EXCLUDED.contact_name,
              subject = EXCLUDED.subject, body_text = EXCLUDED.body_text,
              followup_subject = EXCLUDED.followup_subject,
              followup_body_text = EXCLUDED.followup_body_text, updated_at = now()
          `,
          [runId, candidate.contactId, candidate.audienceKey, candidate.audienceType, candidate.toEmail, candidate.contactName, candidate.subject, candidate.bodyText, candidate.followupSubject, candidate.followupBodyText],
        );
      }
    }
    const updated = (await client.query(
      `
        UPDATE company_research_runs
        SET status = $3, last_error = NULLIF($4, ''), claimed_by = NULL,
            lease_expires_at = NULL, completed_at = now(), updated_at = now()
        WHERE id = $1 AND claimed_by = $2
        RETURNING *
      `,
      [runId, workerId, finalStatus, clean(error)],
    )).rows[0];
    return updated;
  });
}
