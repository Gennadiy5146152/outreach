import { pathToFileURL } from "node:url";
import { env } from "../config/env.js";
import { pool, query, withClient } from "../db/pool.js";
import { claimJob, failJob, finishJob, PERSONALIZATION_JOB_TYPES } from "../services/job-queue.js";
import { confirmedContact, generatePersonalizedCopy, qualifyLead } from "../services/lead-personalization.js";
import { createDraftFromPersonalization, upsertEnrichment } from "../services/personalization-store.js";
import { extractSiteSignals, fetchWebsitePages } from "../services/website-enrichment.js";

function clean(value) {
  return String(value || "").trim();
}

function contextEnrichment(row = {}) {
  return row.enrichment || {
    id: row.enrichmentId,
    rules_version: row.rulesVersion,
    canonicalCompany: row.canonicalCompany,
    contactName: row.contactName,
    personalizationFact: row.personalizationFact,
    factSourceUrl: row.factSourceUrl,
    factEvidence: row.factEvidence,
  };
}

function copyEvidence(enrichment) {
  const sourceUrl = clean(enrichment.factSourceUrl || enrichment.fact_source_url);
  const evidence = clean(enrichment.factEvidence || enrichment.fact_evidence);
  if (!sourceUrl || !evidence) return [];
  return [{ id: "process-1", sourceUrl, evidence }];
}

function databaseRepository() {
  return {
    async loadContext(itemId) {
      const row = (await query(
        `
          SELECT item.id, item.pilot_id, item.lead_id, item.status, item.source_row_number,
                 item.draft_id, pilot.rules_version,
                 lead.email, lead.company, lead.website, lead.segment, lead.city, lead.contact_name,
                 enrichment.id AS enrichment_id, enrichment.status AS enrichment_status,
                 enrichment.fit_score, enrichment.fit_reason, enrichment.canonical_company,
                 enrichment.business_type, enrichment.city AS enrichment_city,
                 enrichment.contact_name AS enriched_contact_name,
                 enrichment.contact_position, enrichment.contact_confidence,
                 enrichment.alternative_contacts, enrichment.personalization_fact,
                 enrichment.fact_source_url, enrichment.fact_evidence,
                 enrichment.source_pages,
                 draft.manually_edited_at
          FROM personalization_pilot_items item
          JOIN personalization_pilots pilot ON pilot.id = item.pilot_id
          JOIN leads lead ON lead.id = item.lead_id
          LEFT JOIN lead_enrichments enrichment ON enrichment.id = item.lead_enrichment_id
          LEFT JOIN outreach_drafts draft ON draft.id = item.draft_id
          WHERE item.id = $1
        `,
        [itemId],
      )).rows[0];
      if (!row) return null;
      return {
        id: row.id,
        pilotId: row.pilot_id,
        leadId: row.lead_id,
        status: row.status,
        sourceRowNumber: row.source_row_number,
        draftId: row.draft_id,
        manuallyEditedAt: row.manually_edited_at,
        rulesVersion: row.rules_version,
        lead: {
          id: row.lead_id,
          email: row.email,
          company: row.company,
          website: row.website,
          segment: row.segment,
          city: row.city,
          contact_name: row.contact_name,
        },
        enrichment: row.enrichment_id ? {
          id: row.enrichment_id,
          status: row.enrichment_status,
          fitScore: row.fit_score,
          fitReason: row.fit_reason,
          canonicalCompany: row.canonical_company,
          businessType: row.business_type,
          city: row.enrichment_city,
          contactName: row.enriched_contact_name,
          contactPosition: row.contact_position,
          contactConfidence: row.contact_confidence,
          alternativeContacts: row.alternative_contacts,
          personalizationFact: row.personalization_fact,
          factSourceUrl: row.fact_source_url,
          factEvidence: row.fact_evidence,
          sourcePages: row.source_pages,
          rules_version: row.rules_version,
        } : null,
      };
    },

    async markItem(itemId, patch) {
      const columns = [];
      const values = [];
      const mappings = {
        status: "status",
        statusReason: "status_reason",
        lastError: "last_error",
        enrichmentId: "lead_enrichment_id",
        draftId: "draft_id",
      };
      for (const [key, column] of Object.entries(mappings)) {
        if (!Object.hasOwn(patch, key)) continue;
        values.push(patch[key]);
        columns.push(`${column} = $${values.length}`);
      }
      if (!columns.length) return;
      values.push(itemId);
      await query(
        `UPDATE personalization_pilot_items SET ${columns.join(", ")}, updated_at = now() WHERE id = $${values.length}`,
        values,
      );
    },

    async saveEnrichment(input) {
      return upsertEnrichment(pool, input);
    },

    async enqueueGeneration({ itemId, pilotId }) {
      await query(
        `
          INSERT INTO job_queue(job_type, payload)
          SELECT 'generate_personalized_draft', jsonb_build_object('itemId', $1::text, 'pilotId', $2::text)
          WHERE NOT EXISTS (
            SELECT 1 FROM job_queue
            WHERE job_type = 'generate_personalized_draft'
              AND payload->>'itemId' = $1::text
              AND status IN ('pending','running','retrying','done')
          )
        `,
        [itemId, pilotId],
      );
    },

    async createDraft({ context, enrichment, copy }) {
      return withClient((client) => createDraftFromPersonalization(client, {
        pilotId: context.pilotId,
        lead: context.lead,
        enrichment,
        copy,
        sourceRowNumber: context.sourceRowNumber,
      }));
    },

    async updatePilotProgress(pilotId) {
      const pilot = (await query(
        `
          WITH counts AS (
            SELECT count(*)::int AS total,
                   count(*) FILTER (WHERE status = 'ready')::int AS ready,
                   count(*) FILTER (WHERE status IN ('review','excluded'))::int AS blocked,
                   count(*) FILTER (WHERE status = 'failed')::int AS failed,
                   count(*) FILTER (WHERE status IN ('pending','enriching','qualified','generating'))::int AS active
            FROM personalization_pilot_items
            WHERE pilot_id = $1
          )
          UPDATE personalization_pilots pilot
          SET status = CASE
                WHEN counts.active > 0 THEN 'running'
                WHEN counts.failed > 0 THEN 'completed_with_errors'
                ELSE 'completed'
              END,
              completed_at = CASE WHEN counts.active = 0 THEN now() ELSE NULL END,
              updated_at = now()
          FROM counts
          WHERE pilot.id = $1
          RETURNING pilot.outreach_import_id, counts.total, counts.ready, counts.blocked, counts.failed, counts.active
        `,
        [pilotId],
      )).rows[0];
      if (!pilot?.outreach_import_id) return;
      await query(
        `
          UPDATE outreach_imports
          SET status = CASE WHEN $5::int > 0 THEN 'processing' WHEN $6::int > 0 THEN 'completed_with_errors' ELSE 'completed' END,
              rows_total = $2, rows_ready = $3, rows_blocked = $4,
              completed_at = CASE WHEN $5::int = 0 THEN now() ELSE NULL END
          WHERE id = $1
        `,
        [pilot.outreach_import_id, pilot.total, pilot.ready, pilot.blocked + pilot.failed, pilot.active, pilot.failed],
      );
    },

    async recordJobFailure(job, error) {
      const itemId = clean(job.payload?.itemId);
      if (!itemId) return;
      const context = await this.loadContext(itemId);
      if (!context) return;
      await this.markItem(itemId, {
        status: "failed",
        lastError: clean(error?.message || error).slice(0, 500),
      });
      await this.updatePilotProgress(context.pilotId);
    },
  };
}

export function createPersonalizationProcessor({
  repository,
  fetchPages = fetchWebsitePages,
  extractSignals = extractSiteSignals,
  qualify = qualifyLead,
  resolveContact = confirmedContact,
  generateCopy = generatePersonalizedCopy,
} = {}) {
  if (!repository) throw new Error("personalization_repository_required");

  async function enrich(job) {
    const context = await repository.loadContext(job.payload?.itemId);
    if (!context) throw new Error("personalization_item_not_found");
    if (["qualified", "review", "excluded", "ready"].includes(context.status) && context.enrichment) {
      await repository.updatePilotProgress(context.pilotId);
      return;
    }
    if (!clean(context.lead?.website)) throw new Error("personalization_website_required");
    await repository.markItem(context.id, { status: "enriching", lastError: null });
    const result = await fetchPages({ website: context.lead.website });
    const signals = extractSignals(result.pages);
    signals.pageTextLength = result.pages.reduce((total, page) => total + clean(page.text).length, 0);
    if (!result.pages.length) signals.unavailable = true;
    const qualification = qualify({ lead: context.lead, signals });
    const contact = resolveContact({ lead: context.lead, signals });
    const fact = qualification.fact;
    const enrichment = await repository.saveEnrichment({
      leadId: context.lead.id,
      status: qualification.status,
      fitScore: qualification.score,
      fitReason: qualification.reason,
      canonicalCompany: signals.canonicalCompany,
      businessType: signals.businessType,
      city: signals.city,
      contactName: contact?.confirmed ? contact.name : null,
      contactPosition: contact?.confirmed ? contact.position : null,
      contactConfidence: contact?.confidence ?? null,
      alternativeContacts: signals.alternativeEmails || [],
      personalizationFact: fact ? `На сайте подтверждён процесс: ${fact.evidence}` : null,
      factSourceUrl: fact?.sourceUrl || null,
      factEvidence: fact?.evidence || null,
      sourcePages: result.pages.map((page) => ({ url: page.url })),
      rulesVersion: job.payload?.rulesVersion || context.rulesVersion,
      promptVersion: "personalization-v1",
      lastError: result.errors.length ? result.errors.map((item) => item.error).join("; ").slice(0, 500) : null,
    });
    await repository.markItem(context.id, {
      status: qualification.status,
      statusReason: qualification.reason,
      enrichmentId: enrichment.id,
      lastError: null,
    });
    if (qualification.status === "qualified") {
      await repository.enqueueGeneration({ itemId: context.id, pilotId: context.pilotId });
    }
    await repository.updatePilotProgress(context.pilotId);
  }

  async function generate(job) {
    const context = await repository.loadContext(job.payload?.itemId);
    if (!context) throw new Error("personalization_item_not_found");
    if (context.status === "ready" || context.draftId || context.manuallyEditedAt) {
      await repository.updatePilotProgress(context.pilotId);
      return;
    }
    const saved = contextEnrichment(context);
    if (!saved?.id || saved.status !== "qualified") throw new Error("personalization_enrichment_not_qualified");
    await repository.markItem(context.id, { status: "generating", lastError: null });
    const enrichment = {
      ...saved,
      evidence: copyEvidence(saved),
    };
    const copy = await generateCopy({ lead: context.lead, enrichment });
    const draft = await repository.createDraft({ context, enrichment: saved, copy });
    await repository.markItem(context.id, { status: "ready", draftId: draft.draftId, enrichmentId: saved.id, lastError: null });
    await repository.updatePilotProgress(context.pilotId);
  }

  return {
    async handleJob(job) {
      if (job.job_type === "enrich_lead") return enrich(job);
      if (job.job_type === "generate_personalized_draft") return generate(job);
      throw new Error(`personalization_job_not_allowed:${job.job_type}`);
    },
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPersonalizer() {
  const repository = databaseRepository();
  const processor = createPersonalizationProcessor({ repository });
  let stopping = false;
  process.on("SIGTERM", () => { stopping = true; });
  console.log("Outreach personalizer started");
  while (!stopping) {
    const job = await withClient((client) => claimJob(client, { jobTypes: PERSONALIZATION_JOB_TYPES }));
    if (!job) {
      await sleep(Math.max(1000, Number(env.workerPollMs || 3000)));
      continue;
    }
    try {
      await processor.handleJob(job);
      await finishJob({ query }, job.id);
    } catch (error) {
      console.error(`Personalization job ${job.id} failed: ${clean(error?.message || error).slice(0, 500)}`);
      await repository.recordJobFailure(job, error).catch(() => {});
      await failJob({ query }, job, error);
    }
  }
  await pool.end();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runPersonalizer();
}
