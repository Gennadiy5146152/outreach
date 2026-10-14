import crypto from "node:crypto";
import {
  COMPANY_RESEARCH_RULES_VERSION,
  claimResearchRun,
  companyResearchKey,
  completeResearchRun,
  createResearchRuns,
  researchEligibility,
  researchPriority,
  saveResearchBundle,
} from "./company-research.js";

const ACTIVE_CONVERSATION_STATUSES = ["active_sequence", "waiting_reply_review", "manual_reply_needed", "paused", "positive"];

function clean(value) {
  return String(value || "").trim();
}

function apiError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function boundedPagination({ page = 1, pageSize = 50 } = {}) {
  const normalizedPage = Math.max(Math.trunc(Number(page) || 1), 1);
  const normalizedPageSize = Math.min(Math.max(Math.trunc(Number(pageSize) || 50), 5), 100);
  return { page: normalizedPage, pageSize: normalizedPageSize, offset: (normalizedPage - 1) * normalizedPageSize };
}

function eligibleCompaniesSql() {
  return `
    SELECT lead.id, lead.company, lead.email, lead.website, lead.domain, lead.segment,
           lead.city, lead.validation_status, lead.updated_at
    FROM leads lead
    WHERE lead.validation_status IN ('valid', 'risky')
      AND lead.status <> 'suppressed'
      AND btrim(lead.company) <> ''
      AND btrim(lead.email) <> ''
      AND NOT EXISTS (
        SELECT 1 FROM suppressions suppression
        WHERE lower(suppression.email) = lower(lead.email)
           OR (suppression.domain IS NOT NULL AND lower(suppression.domain) = lower(lead.domain))
      )
      AND NOT EXISTS (
        SELECT 1 FROM outreach_conversations conversation
        WHERE lower(conversation.email) = lower(lead.email)
          AND conversation.status = ANY($1::text[])
      )
      AND NOT EXISTS (
        SELECT 1
        FROM messages sent_message
        JOIN leads sent_lead ON sent_lead.id = sent_message.lead_id
        WHERE sent_message.direction = 'outbound'
          AND sent_message.type = 'outreach'
          AND sent_message.status = 'sent'
          AND lower(sent_lead.email) = lower(lead.email)
      )
    ORDER BY lead.updated_at DESC, lead.id
    LIMIT 10000
  `;
}

function prioritizeAndDedupe(rows) {
  const grouped = new Map();
  for (const row of rows) {
    let companyKey;
    try {
      companyKey = companyResearchKey(row);
    } catch {
      continue;
    }
    const email = clean(row.email).toLowerCase();
    if (!email) continue;
    const eligibility = researchEligibility(row);
    let group = grouped.get(companyKey);
    if (!group) {
      group = { companyKey, decision: eligibility, eligibleRow: null, recipients: [] };
      grouped.set(companyKey, group);
    }
    const decisionRank = { needs_size_review: 1, eligible: 2, excluded: 3 };
    if (decisionRank[eligibility.status] > decisionRank[group.decision.status]) group.decision = eligibility;
    if (eligibility.status === "eligible" && !group.eligibleRow) group.eligibleRow = row;
    if (!group.recipients.some((recipient) => recipient.email === email)) {
      group.recipients.push({
        id: row.id,
        email,
        updated_at: row.updated_at,
      });
    }
  }
  const companies = [];
  const counts = { excluded: 0, needs_size_review: 0, by_reason: {} };
  for (const group of grouped.values()) {
    if (group.decision.status !== "eligible") {
      counts[group.decision.status] = Number(counts[group.decision.status] || 0) + 1;
      counts.by_reason[group.decision.reason] = Number(counts.by_reason[group.decision.reason] || 0) + 1;
      continue;
    }
    const priority = researchPriority(group.eligibleRow);
    companies.push({
      ...group.eligibleRow,
      company_key: group.companyKey,
      priority_tier: priority.tier,
      priority_reason: priority.reason,
      recipients: group.recipients,
    });
  }
  companies.sort((left, right) => (
    left.priority_tier - right.priority_tier || String(left.company_key).localeCompare(String(right.company_key))
  ));
  return { companies, counts };
}

export function researchQueueToken(companies, rulesVersion) {
  return hash({
    rulesVersion,
    snapshot: companies.map((company) => [
      company.id,
      company.company_key,
      company.priority_tier,
      company.recipients.map((recipient) => [recipient.id, recipient.email, new Date(recipient.updated_at || 0).toISOString()]),
    ]),
  });
}

function draftToken(drafts) {
  return hash(drafts.map((draft) => [draft.id, draft.status || "candidate", new Date(draft.updated_at || 0).toISOString(), draft.to_email]));
}

function orderedByIds(rows, ids) {
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  return ids.map((id) => byId.get(String(id))).filter(Boolean);
}

async function fetchDraftCandidates(queryFn, draftIds, { lock = false } = {}) {
  if (!Array.isArray(draftIds) || !draftIds.length || draftIds.length > 500) throw apiError("company_research_draft_selection_invalid");
  const result = await queryFn(
    `
      SELECT draft.*, COALESCE(recipient.lead_id, run.lead_id) AS lead_id, lead.company, lead.segment
      FROM company_research_drafts draft
      JOIN company_research_runs run ON run.id = draft.research_run_id
      JOIN leads lead ON lead.id = run.lead_id
      LEFT JOIN company_research_recipients recipient ON recipient.id = draft.recipient_id
      WHERE draft.id = ANY($1::uuid[]) AND draft.status = 'candidate'
        AND NOT EXISTS (
          SELECT 1
          FROM messages sent_message
          JOIN leads sent_lead ON sent_lead.id = sent_message.lead_id
          WHERE sent_message.direction = 'outbound'
            AND sent_message.type = 'outreach'
            AND sent_message.status = 'sent'
            AND lower(sent_lead.email) = lower(draft.to_email)
        )
      ${lock ? "FOR UPDATE OF draft" : ""}
    `,
    [draftIds],
  );
  return orderedByIds(result.rows, draftIds);
}

async function transaction(client, operation) {
  await client.query("BEGIN");
  try {
    const value = await operation();
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export function createCompanyResearchApi({
  query: queryFn,
  withClient: withClientFn,
  createResearchRunsFn = createResearchRuns,
  claimResearchRunFn = claimResearchRun,
  saveResearchBundleFn = saveResearchBundle,
  completeResearchRunFn = completeResearchRun,
} = {}) {
  async function currentQueue(rulesVersion = COMPANY_RESEARCH_RULES_VERSION) {
    if (!queryFn) throw new Error("company_research_query_required");
    const rows = (await queryFn(eligibleCompaniesSql(), [ACTIVE_CONVERSATION_STATUSES])).rows;
    const selection = prioritizeAndDedupe(rows);
    const companies = selection.companies;
    const byPriority = {};
    for (const company of companies) byPriority[company.priority_tier] = (byPriority[company.priority_tier] || 0) + 1;
    return {
      rulesVersion,
      companies,
      counts: {
        selected: companies.length,
        recipients: companies.reduce((total, company) => total + company.recipients.length, 0),
        excluded: selection.counts.excluded,
        needs_size_review: selection.counts.needs_size_review,
        by_reason: selection.counts.by_reason,
        by_priority: byPriority,
      },
      selectionToken: researchQueueToken(companies, rulesVersion),
    };
  }

  return {
    async previewQueue({ rulesVersion = COMPANY_RESEARCH_RULES_VERSION } = {}) {
      return currentQueue(rulesVersion);
    },

    async createQueue({ rulesVersion = COMPANY_RESEARCH_RULES_VERSION, leadIds = [], selectionToken } = {}) {
      const preview = await currentQueue(rulesVersion);
      const ids = [...new Set(leadIds.map(clean).filter(Boolean))];
      if (!ids.length || ids.length !== preview.companies.length || preview.selectionToken !== clean(selectionToken)) {
        throw apiError("company_research_preview_stale", 409);
      }
      const companies = orderedByIds(preview.companies, ids);
      if (companies.length !== ids.length) throw apiError("company_research_preview_stale", 409);
      if (!withClientFn) throw new Error("company_research_client_required");
      return withClientFn((client) => createResearchRunsFn(client, { leads: companies, rulesVersion }));
    },

    async listRuns({ page, pageSize, status = "" } = {}) {
      if (!queryFn) throw new Error("company_research_query_required");
      const pagination = boundedPagination({ page, pageSize });
      const [rows, total] = await Promise.all([
        queryFn(
          `
            SELECT run.*, lead.company, lead.email, lead.website, lead.segment, lead.city,
                   (SELECT count(*)::int FROM company_research_sources WHERE research_run_id = run.id) AS source_count,
                   (SELECT count(*)::int FROM company_research_recipients WHERE research_run_id = run.id AND status <> 'excluded') AS recipient_count,
                   (SELECT count(*)::int FROM company_contacts WHERE research_run_id = run.id) AS contact_count,
                   (SELECT count(*)::int FROM company_research_drafts WHERE research_run_id = run.id) AS draft_count
            FROM company_research_runs run
            JOIN leads lead ON lead.id = run.lead_id
            WHERE ($1 = '' OR run.status = $1)
            ORDER BY run.priority_tier, run.created_at, run.id
            LIMIT $2 OFFSET $3
          `,
          [clean(status), pagination.pageSize, pagination.offset],
        ),
        queryFn("SELECT count(*)::int AS total FROM company_research_runs WHERE ($1 = '' OR status = $1)", [clean(status)]),
      ]);
      const count = Number(total.rows[0]?.total || 0);
      return { rows: rows.rows, pagination: { page: pagination.page, pageSize: pagination.pageSize, total: count, totalPages: Math.max(Math.ceil(count / pagination.pageSize), 1) } };
    },

    async getRun(runId) {
      if (!queryFn) throw new Error("company_research_query_required");
      const run = (await queryFn(
        `SELECT run.*, lead.company, lead.email, lead.website, lead.segment, lead.city FROM company_research_runs run JOIN leads lead ON lead.id = run.lead_id WHERE run.id = $1`,
        [runId],
      )).rows[0] || null;
      if (!run) return null;
      const [recipients, sources, facts, contacts, drafts] = await Promise.all([
        queryFn("SELECT * FROM company_research_recipients WHERE research_run_id = $1 AND status <> 'excluded' ORDER BY created_at, id", [runId]),
        queryFn("SELECT * FROM company_research_sources WHERE research_run_id = $1 ORDER BY trust_tier, created_at", [runId]),
        queryFn("SELECT * FROM company_research_facts WHERE research_run_id = $1 ORDER BY selected_for_copy DESC, confidence DESC", [runId]),
        queryFn("SELECT * FROM company_contacts WHERE research_run_id = $1 ORDER BY email_status, confidence DESC", [runId]),
        queryFn("SELECT * FROM company_research_drafts WHERE research_run_id = $1 ORDER BY audience_type, created_at", [runId]),
      ]);
      return { run, recipients: recipients.rows, sources: sources.rows, facts: facts.rows, contacts: contacts.rows, drafts: drafts.rows };
    },

    async claimJob({ workerId, leaseMinutes } = {}) {
      if (!withClientFn) throw new Error("company_research_client_required");
      const run = await withClientFn((client) => claimResearchRunFn(client, { workerId, leaseMinutes }));
      if (!run) return { job: null };
      return { job: await this.getRun(run.id) };
    },

    async saveEvidence(runId, input = {}) {
      if (!withClientFn) throw new Error("company_research_client_required");
      return withClientFn((client) => saveResearchBundleFn(client, {
        runId,
        workerId: input.workerId,
        sources: input.sources || [],
        facts: input.facts || [],
        contacts: input.contacts || [],
      }));
    },

    async completeJob(runId, input = {}) {
      if (!withClientFn) throw new Error("company_research_client_required");
      return withClientFn((client) => completeResearchRunFn(client, {
        runId,
        workerId: input.workerId,
        status: input.status,
        error: input.error,
      }));
    },

    async retryRun(runId) {
      if (!queryFn) throw new Error("company_research_query_required");
      const result = await queryFn(
        `
          UPDATE company_research_runs
          SET status = 'queued', claimed_by = NULL, lease_expires_at = NULL,
              last_error = NULL, completed_at = NULL, updated_at = now()
          WHERE id = $1 AND status IN ('failed','review')
          RETURNING *
        `,
        [runId],
      );
      if (!result.rowCount) throw apiError("company_research_retry_not_allowed", 409);
      return result.rows[0];
    },

    async previewDrafts({ draftIds = [] } = {}) {
      if (!queryFn) throw new Error("company_research_query_required");
      const ids = [...new Set(draftIds.map(clean).filter(Boolean))];
      const drafts = await fetchDraftCandidates(queryFn, ids);
      if (drafts.length !== ids.length) throw apiError("company_research_drafts_changed", 409);
      return { drafts, selectionToken: draftToken(drafts) };
    },

    async materializeDrafts({ draftIds = [], selectionToken } = {}) {
      if (!withClientFn) throw new Error("company_research_client_required");
      const ids = [...new Set(draftIds.map(clean).filter(Boolean))];
      return withClientFn((client) => transaction(client, async () => {
        const drafts = await fetchDraftCandidates((sql, params) => client.query(sql, params), ids, { lock: true });
        if (drafts.length !== ids.length || draftToken(drafts) !== clean(selectionToken)) {
          throw apiError("company_research_drafts_changed", 409);
        }
        const importRow = (await client.query(
          `
            INSERT INTO outreach_imports(file_name, file_type, status, rows_total, rows_ready, rows_blocked, rows_skipped, completed_at)
            VALUES ($1, 'company_research', 'completed', $2, $2, 0, 0, now())
            RETURNING id
          `,
          [`Исследование компаний ${new Date().toISOString()}`, drafts.length],
        )).rows[0];
        const materializedIds = [];
        for (let index = 0; index < drafts.length; index += 1) {
          const draft = drafts[index];
          const inserted = (await client.query(
            `
              INSERT INTO outreach_drafts(
                import_id, source_row_number, lead_id, to_email, company, contact_name,
                segment, subject, body_text, status, raw_row
              )
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10::jsonb)
              RETURNING id
            `,
            [importRow.id, index + 1, draft.lead_id, draft.to_email, draft.company || "", draft.contact_name || "", draft.segment || "", draft.subject, draft.body_text, JSON.stringify({ company_research: true, research_run_id: draft.research_run_id, research_draft_id: draft.id, audience_key: draft.audience_key })],
          )).rows[0];
          await client.query(
            `
              INSERT INTO outreach_draft_steps(draft_id, position, subject, body_text, delay_days, status)
              VALUES ($1,1,$2,$3,0,'ready'),($1,2,$4,$5,2,'ready')
            `,
            [inserted.id, draft.subject, draft.body_text, draft.followup_subject, draft.followup_body_text],
          );
          await client.query(
            "UPDATE company_research_drafts SET status = 'materialized', materialized_draft_id = $2, updated_at = now() WHERE id = $1",
            [draft.id, inserted.id],
          );
          materializedIds.push(inserted.id);
        }
        return { materialized: materializedIds.length, draftIds: materializedIds, importId: importRow.id };
      }));
    },
  };
}
