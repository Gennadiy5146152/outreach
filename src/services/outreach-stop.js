export const OUTREACH_STOP_SCOPES = new Set(["contact_only", "same_domain", "same_company"]);

export function normalizeOutreachStopScope(value) {
  return OUTREACH_STOP_SCOPES.has(value) ? value : "contact_only";
}

function exec(db, sql, params = []) {
  return typeof db === "function" ? db(sql, params) : db.query(sql, params);
}

export async function affectedLeadIds(db, leadId, scope) {
  const normalizedScope = normalizeOutreachStopScope(scope);
  const result = await exec(
    db,
    `
      WITH source AS (
        SELECT
          id,
          NULLIF(lower(domain), '') AS domain,
          NULLIF(lower(company), '') AS company
        FROM leads
        WHERE id = $1
      )
      SELECT DISTINCT l.id
      FROM leads l
      CROSS JOIN source s
      WHERE l.id = s.id
        OR ($2 = 'same_domain' AND s.domain IS NOT NULL AND lower(l.domain) = s.domain)
        OR ($2 = 'same_company' AND s.company IS NOT NULL AND lower(l.company) = s.company)
    `,
    [leadId, normalizedScope],
  );
  return result.rows.map((row) => row.id);
}

export async function cancelOutreachForScope(db, { leadId, scope, reason }) {
  const leadIds = await affectedLeadIds(db, leadId, scope);
  if (!leadIds.length) return { affectedLeads: 0, cancelledQueue: 0, cancelledSteps: 0, leadIds };

  const cancelled = await exec(
    db,
    `
      UPDATE sending_queue
      SET status = 'cancelled',
          last_error = $2,
          updated_at = now()
      WHERE lead_id = ANY($1::uuid[])
        AND outreach_draft_id IS NOT NULL
        AND status IN ('pending','retrying')
      RETURNING outreach_step_id
    `,
    [leadIds, reason],
  );
  const stepIds = cancelled.rows.map((row) => row.outreach_step_id).filter(Boolean);
  let cancelledSteps = 0;
  if (stepIds.length) {
    cancelledSteps = (await exec(
      db,
      "UPDATE outreach_draft_steps SET status = 'cancelled', updated_at = now() WHERE id = ANY($1::uuid[])",
      [stepIds],
    )).rowCount;
  }

  await exec(
    db,
    `
      UPDATE outreach_drafts
      SET status = 'paused',
          updated_at = now()
      WHERE lead_id = ANY($1::uuid[])
        AND status IN ('queued','active_sequence')
    `,
    [leadIds],
  );

  await exec(
    db,
    `
      UPDATE enrollments
      SET status = 'paused',
          stopped_at = now(),
          stop_reason = $2
      WHERE lead_id = ANY($1::uuid[])
        AND status = 'active'
    `,
    [leadIds, `scope_${normalizeOutreachStopScope(scope)}`],
  );

  return { affectedLeads: leadIds.length, cancelledQueue: cancelled.rowCount, cancelledSteps, leadIds };
}

export async function holdOutreachForScope(db, { leadId, scope, reason }) {
  const leadIds = await affectedLeadIds(db, leadId, scope);
  if (!leadIds.length) return { affectedLeads: 0, heldQueue: 0, heldSteps: 0, leadIds };

  const held = await exec(
    db,
    `
      UPDATE sending_queue
      SET requires_approval = true,
          approved_at = NULL,
          last_error = $2,
          updated_at = now()
      WHERE lead_id = ANY($1::uuid[])
        AND outreach_draft_id IS NOT NULL
        AND status IN ('pending','retrying')
      RETURNING outreach_step_id
    `,
    [leadIds, reason],
  );
  const stepIds = held.rows.map((row) => row.outreach_step_id).filter(Boolean);
  let heldSteps = 0;
  if (stepIds.length) {
    heldSteps = (await exec(
      db,
      "UPDATE outreach_draft_steps SET status = 'needs_approval', updated_at = now() WHERE id = ANY($1::uuid[])",
      [stepIds],
    )).rowCount;
  }

  await exec(
    db,
    `
      UPDATE outreach_conversations
      SET status = CASE WHEN lead_id = $2 THEN status ELSE 'manual_reply_needed' END,
          next_action = CASE WHEN lead_id = $2 THEN next_action ELSE 'company_scope_reply_review' END,
          updated_at = now()
      WHERE lead_id = ANY($1::uuid[])
        AND status IN ('active_sequence','waiting_reply_review','manual_reply_needed','paused')
    `,
    [leadIds, leadId],
  );

  await exec(
    db,
    `
      UPDATE enrollments
      SET status = CASE WHEN lead_id = $2 THEN 'replied' ELSE 'paused' END,
          stopped_at = now(),
          stop_reason = $3
      WHERE lead_id = ANY($1::uuid[])
        AND status = 'active'
    `,
    [leadIds, leadId, `scope_${normalizeOutreachStopScope(scope)}`],
  );

  return { affectedLeads: leadIds.length, heldQueue: held.rowCount, heldSteps, leadIds };
}
