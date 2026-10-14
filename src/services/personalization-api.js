import crypto from "node:crypto";
import { createPilot, getPilot } from "./personalization-store.js";

const RULES_VERSION = "backup-personalization-v1";
const ACTIVE_CONVERSATION_STATUSES = [
  "active_sequence",
  "waiting_reply_review",
  "manual_reply_needed",
  "paused",
  "positive",
];

function clean(value) {
  return String(value || "").trim();
}

function apiError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function boundedLimit(value) {
  const limit = Math.trunc(Number(value || 30));
  if (limit < 1 || limit > 30) throw apiError("personalization_limit_invalid", 400);
  return limit;
}

function eligibleLeadsSql({ byIds = false } = {}) {
  return `
    SELECT lead.id, lead.company, lead.email, lead.website, lead.segment, lead.city,
           lead.validation_status, lead.updated_at
    FROM leads lead
    WHERE lead.validation_status IN ('valid', 'risky')
      AND lead.status <> 'suppressed'
      AND lead.website IS NOT NULL
      AND btrim(lead.website) <> ''
      ${byIds ? "AND lead.id = ANY($1::uuid[])" : ""}
      AND NOT EXISTS (
        SELECT 1 FROM suppressions suppression
        WHERE lower(suppression.email) = lower(lead.email)
           OR (suppression.domain IS NOT NULL AND lower(suppression.domain) = lower(lead.domain))
      )
      AND NOT EXISTS (
        SELECT 1 FROM outreach_conversations conversation
        WHERE lower(conversation.email) = lower(lead.email)
          AND conversation.status = ANY($${byIds ? 2 : 1}::text[])
      )
      AND NOT EXISTS (
        SELECT 1 FROM outreach_drafts draft
        WHERE lower(draft.to_email) = lower(lead.email)
          AND (
            draft.lead_enrichment_id IS NOT NULL
            OR draft.raw_row->>'personalization' = 'true'
            OR draft.subject ILIKE '%резервн%'
            OR draft.body_text ILIKE '%правилу 3-2-1%'
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM messages message
        WHERE message.lead_id = lead.id
          AND message.direction = 'outbound'
          AND message.type = 'outreach'
          AND (message.subject ILIKE '%резервн%' OR message.body_text ILIKE '%правилу 3-2-1%')
      )
    ORDER BY lead.segment NULLS LAST, lead.city NULLS LAST, lead.updated_at DESC, lead.id
    ${byIds ? "" : "LIMIT $2"}
  `;
}

export function selectDiverseLeads(rows, limit) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${clean(row.segment).toLowerCase() || "other"}|${clean(row.city).toLowerCase() || "unknown"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const selected = [];
  const queues = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, items]) => items);
  while (selected.length < limit && queues.some((items) => items.length)) {
    for (const items of queues) {
      if (selected.length >= limit) break;
      const row = items.shift();
      if (row) selected.push(row);
    }
  }
  return selected;
}

export function createSelectionToken(rows, rulesVersion) {
  const snapshot = rows.map((row) => [
    clean(row.id),
    new Date(row.updated_at || 0).toISOString(),
    clean(row.validation_status),
  ]);
  return crypto.createHash("sha256").update(JSON.stringify({ rulesVersion, snapshot })).digest("hex");
}

function orderedRows(rows, leadIds) {
  const byId = new Map(rows.map((row) => [clean(row.id), row]));
  return leadIds.map((id) => byId.get(clean(id))).filter(Boolean);
}

export function createPersonalizationApi({
  query: queryFn,
  withClient: withClientFn,
  createPilotFn = createPilot,
  getPilotFn = getPilot,
} = {}) {
  async function findEligible({ limit, leadIds } = {}) {
    if (!queryFn) throw new Error("personalization_query_required");
    if (leadIds) {
      const result = await queryFn(eligibleLeadsSql({ byIds: true }), [leadIds, ACTIVE_CONVERSATION_STATUSES]);
      return orderedRows(result.rows, leadIds);
    }
    const result = await queryFn(eligibleLeadsSql(), [ACTIVE_CONVERSATION_STATUSES, Math.max(limit * 8, 100)]);
    return selectDiverseLeads(result.rows, limit);
  }

  return {
    async listPilots() {
      if (!queryFn) throw new Error("personalization_query_required");
      return (await queryFn(
        `
          SELECT pilot.*,
                 count(item.id)::int AS total,
                 count(item.id) FILTER (WHERE item.status = 'ready')::int AS ready,
                 count(item.id) FILTER (WHERE item.status = 'failed')::int AS failed,
                 count(item.id) FILTER (WHERE item.status IN ('review','excluded'))::int AS needs_review
          FROM personalization_pilots pilot
          LEFT JOIN personalization_pilot_items item ON item.pilot_id = pilot.id
          GROUP BY pilot.id
          ORDER BY pilot.created_at DESC
          LIMIT 50
        `,
      )).rows;
    },

    async getPilotDetail(pilotId) {
      if (!withClientFn) throw new Error("personalization_client_required");
      return withClientFn((client) => getPilotFn(client, pilotId));
    },

    async previewPilot({ limit = 30, rulesVersion = RULES_VERSION } = {}) {
      const normalizedLimit = boundedLimit(limit);
      const leads = await findEligible({ limit: normalizedLimit });
      return {
        limit: normalizedLimit,
        rulesVersion,
        leads,
        counts: {
          selected: leads.length,
          valid: leads.filter((lead) => lead.validation_status === "valid").length,
          risky: leads.filter((lead) => lead.validation_status === "risky").length,
        },
        selectionToken: createSelectionToken(leads, rulesVersion),
      };
    },

    async startPilot({ limit = 30, rulesVersion = RULES_VERSION, leadIds = [], selectionToken } = {}) {
      const normalizedLimit = boundedLimit(limit);
      const uniqueIds = [...new Set(leadIds.map(clean).filter(Boolean))];
      if (!uniqueIds.length || uniqueIds.length > normalizedLimit) throw apiError("personalization_selection_invalid", 400);
      const current = await findEligible({ leadIds: uniqueIds });
      const currentToken = createSelectionToken(current, rulesVersion);
      if (current.length !== uniqueIds.length || currentToken !== clean(selectionToken)) {
        throw apiError("personalization_preview_stale", 409);
      }
      if (!withClientFn) throw new Error("personalization_client_required");
      const pilot = await withClientFn((client) => createPilotFn(client, {
        limit: normalizedLimit,
        rulesVersion,
        leadIds: uniqueIds,
        selectionToken: currentToken,
        enqueueJobType: "enrich_lead",
      }));
      return { pilot, queued: uniqueIds.length };
    },

    async retryPilot(pilotId) {
      if (!queryFn) throw new Error("personalization_query_required");
      const failed = await queryFn(
        `
          UPDATE personalization_pilot_items
          SET status = 'pending', last_error = NULL, updated_at = now()
          WHERE pilot_id = $1 AND status = 'failed'
          RETURNING id
        `,
        [pilotId],
      );
      if (failed.rowCount) {
        await queryFn(
          `
            INSERT INTO job_queue(job_type, payload)
            SELECT 'enrich_lead', jsonb_build_object('itemId', item.id::text, 'pilotId', item.pilot_id::text, 'rulesVersion', pilot.rules_version)
            FROM personalization_pilot_items item
            JOIN personalization_pilots pilot ON pilot.id = item.pilot_id
            WHERE item.id = ANY($1::uuid[])
              AND NOT EXISTS (
                SELECT 1 FROM job_queue job
                WHERE job.job_type = 'enrich_lead'
                  AND job.payload->>'itemId' = item.id::text
                  AND job.status IN ('pending','running','retrying')
              )
          `,
          [failed.rows.map((row) => row.id)],
        );
        await queryFn(
          "UPDATE personalization_pilots SET status = 'running', completed_at = NULL, updated_at = now() WHERE id = $1",
          [pilotId],
        );
      }
      return { retried: failed.rowCount };
    },

    async updateItem(itemId, { status, reason, actor, draft } = {}) {
      if (!withClientFn) throw new Error("personalization_client_required");
      return withClientFn(async (client) => {
        await client.query("BEGIN");
        try {
          const item = (await client.query(
            `
              SELECT item.*, draft.manually_edited_at
              FROM personalization_pilot_items item
              LEFT JOIN outreach_drafts draft ON draft.id = item.draft_id
              WHERE item.id = $1
              FOR UPDATE OF item
            `,
            [itemId],
          )).rows[0];
          if (!item) throw apiError("personalization_item_not_found", 404);
          if (status) {
            if (!["qualified", "review", "excluded"].includes(status)) throw apiError("personalization_status_invalid", 400);
            if (status === "qualified" && !item.lead_enrichment_id) {
              throw apiError("personalization_enrichment_pending", 409);
            }
            await client.query(
              `
                UPDATE personalization_pilot_items
                SET status = $2, status_reason = $3, manual_override_by = $4,
                    manually_overridden_at = now(), updated_at = now()
                WHERE id = $1
              `,
              [itemId, status, clean(reason), clean(actor) || "user"],
            );
            if (item.lead_enrichment_id) {
              await client.query(
                "UPDATE lead_enrichments SET status = $2, fit_reason = $3, updated_at = now() WHERE id = $1",
                [item.lead_enrichment_id, status, clean(reason)],
              );
            }
            if (item.draft_id) {
              await client.query(
                "UPDATE outreach_drafts SET status = $2, updated_at = now() WHERE id = $1",
                [item.draft_id, status === "qualified" ? "ready" : "blocked"],
              );
            }
            if (["review", "excluded"].includes(status)) {
              await client.query(
                `
                  UPDATE job_queue
                  SET status = 'done', last_error = 'cancelled_by_manual_override', locked_at = NULL, updated_at = now()
                  WHERE job_type = 'generate_personalized_draft'
                    AND payload->>'itemId' = $1::text
                    AND status IN ('pending','retrying')
                `,
                [itemId],
              );
            }
            if (status === "qualified" && !item.draft_id) {
              await client.query(
                `
                  INSERT INTO job_queue(job_type, payload)
                  SELECT 'generate_personalized_draft', jsonb_build_object('itemId', $1::text, 'pilotId', $2::text)
                  WHERE NOT EXISTS (
                    SELECT 1 FROM job_queue
                    WHERE job_type = 'generate_personalized_draft'
                      AND payload->>'itemId' = $1::text
                      AND status IN ('pending','running','retrying')
                  )
                `,
                [itemId, item.pilot_id],
              );
            }
          }
          if (draft) {
            if (!item.draft_id) throw apiError("personalization_draft_not_found", 404);
            await client.query(
              `
                UPDATE outreach_drafts
                SET subject = COALESCE($2, subject), body_text = COALESCE($3, body_text),
                    manually_edited_at = now(), updated_at = now()
                WHERE id = $1
              `,
              [item.draft_id, draft.subject ?? null, draft.bodyText ?? null],
            );
            await client.query(
              `
                UPDATE outreach_draft_steps
                SET subject = CASE WHEN position = 1 THEN COALESCE($2, subject) ELSE COALESCE($4, subject) END,
                    body_text = CASE WHEN position = 1 THEN COALESCE($3, body_text) ELSE COALESCE($5, body_text) END,
                    updated_at = now()
                WHERE draft_id = $1 AND position IN (1,2)
              `,
              [item.draft_id, draft.subject ?? null, draft.bodyText ?? null, draft.followupSubject ?? null, draft.followupBodyText ?? null],
            );
          }
          await client.query("COMMIT");
          return { id: itemId, status: status || item.status, manuallyEdited: Boolean(draft) };
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        }
      });
    },
  };
}
