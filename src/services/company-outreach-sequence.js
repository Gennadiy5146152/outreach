import { OUTREACH_DELIVERY_LOCK, lockOutreachQueueMutation } from "./outreach-control.js";
import { markdownToHtml } from "./template.js";
import { parseEmail } from "./validation.js";

function problem(code, status = 409) {
  return Object.assign(new Error(code), { status });
}

function delay(value) {
  const days = Number(value ?? 4);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw problem("company_sequence_delay_invalid", 400);
  return days;
}

async function alternateLead(client, draft, email) {
  const parsed = parseEmail(email);
  if (!parsed.syntaxValid || email === draft.to_email.toLowerCase()) return null;
  const { rows: [existing] } = await client.query(`
    SELECT id, email, validation_status, status, suppressed_at,
      COALESCE(NULLIF(lower(btrim(company)), ''), id::text) AS company_key
    FROM leads WHERE lower(email) = $1
  `, [email]);
  if (existing) {
    return existing.company_key === draft.company_key
      && existing.status !== "suppressed" && !existing.suppressed_at
      && existing.validation_status !== "invalid" ? existing : null;
  }

  const { rows: [created] } = await client.query(`
    INSERT INTO leads (company, email, domain, contact_name, position, segment, source)
    SELECT anchor.company, $2, $3, evidence.name, evidence.role, anchor.segment, evidence.source_url
    FROM leads anchor
    CROSS JOIN LATERAL (
      SELECT c.name, c.role, c.source_url
      FROM outreach_channel_contacts c JOIN leads l ON l.id = c.lead_id
      WHERE c.channel IN ('email_general','email_personal') AND lower(c.address) = $2
        AND COALESCE(NULLIF(lower(btrim(l.company)), ''), l.id::text) = $4
      UNION ALL
      SELECT c.name, c.role, source.canonical_url
      FROM company_contacts c
      JOIN company_research_sources source ON source.id = c.source_id
      JOIN company_research_runs run ON run.id = c.research_run_id
      JOIN leads l ON l.id = run.lead_id
      WHERE c.email_status = 'confirmed' AND lower(c.email) = $2
        AND COALESCE(NULLIF(lower(btrim(l.company)), ''), l.id::text) = $4
      LIMIT 1
    ) evidence
    WHERE anchor.id = $1
    ON CONFLICT (email) DO NOTHING
    RETURNING id, email, validation_status
  `, [draft.lead_id, email, parsed.domain, draft.company_key]);
  if (created) {
    await client.query("INSERT INTO job_queue(job_type, payload) VALUES ('validate_lead', $1)", [{ leadId: created.id }]);
  }
  return created || null;
}

export async function saveCompanySequence(client, draftId, input, guardErrors) {
  await lockOutreachQueueMutation(client);
  const { rows: [draft] } = await client.query(`
    SELECT d.*, COALESCE(NULLIF(lower(btrim(l.company)), ''), l.id::text) AS company_key
    FROM outreach_drafts d JOIN leads l ON l.id = d.lead_id
    WHERE d.id = $1 AND lower(l.email) = lower(d.to_email) FOR UPDATE OF d
  `, [draftId]);
  if (!draft || draft.status !== "ready") throw problem("company_sequence_draft_not_ready");
  const { rows: steps } = await client.query(
    "SELECT * FROM outreach_draft_steps WHERE draft_id = $1 ORDER BY position FOR UPDATE", [draftId],
  );
  if (steps.some((step) => step.position > 2 && !step.recipient_lead_id)) {
    throw problem("company_sequence_existing_followups");
  }
  const followup = steps.find((step) => step.position === 2);
  if (!followup || followup.status === "blocked" || !followup.subject || !followup.body_text) {
    throw problem("company_sequence_followup_required");
  }

  const alternate = input.alternate_email?.trim().toLowerCase();
  if (alternate) {
    const lead = await alternateLead(client, draft, alternate);
    if (!lead) throw problem("company_sequence_alternate_unavailable");
    const subject = String(input.alternate_subject || "").trim();
    const body = String(input.alternate_body || "").trim();
    if (!subject || !body || /^re\s*:/i.test(subject) || guardErrors({ subject, body }).length) {
      throw problem("company_sequence_alternate_text_invalid", 400);
    }
    await client.query(`
      INSERT INTO outreach_draft_steps (draft_id, position, subject, body_text, body_html, delay_days, recipient_lead_id, recipient_email)
      VALUES ($1, 3, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (draft_id, position) DO UPDATE SET
        subject = EXCLUDED.subject, body_text = EXCLUDED.body_text, body_html = EXCLUDED.body_html,
        delay_days = EXCLUDED.delay_days, recipient_lead_id = EXCLUDED.recipient_lead_id,
        recipient_email = EXCLUDED.recipient_email, updated_at = now()
    `, [draftId, subject, body, markdownToHtml(body), delay(input.alternate_delay_days), lead.id, lead.email]);
  } else {
    await client.query("DELETE FROM outreach_draft_steps WHERE draft_id = $1 AND recipient_lead_id IS NOT NULL", [draftId]);
  }

  if (input.messenger_contact_id) {
    const body = String(input.messenger_body || "").trim();
    if (!body || body.length > 4000) throw problem("channel_message_invalid", 400);
    const { rowCount } = await client.query(`
      INSERT INTO outreach_channel_tasks (draft_id, contact_id, company_key, body, delay_days, status)
      SELECT $1, c.id, $3, $4, $5, 'draft'
      FROM outreach_channel_contacts c JOIN leads l ON l.id = c.lead_id
      WHERE c.id = $2 AND c.channel IN ('telegram','max','vk')
        AND COALESCE(NULLIF(lower(btrim(l.company)), ''), l.id::text) = $3
      ON CONFLICT (draft_id) DO UPDATE SET
        contact_id = EXCLUDED.contact_id, company_key = EXCLUDED.company_key,
        body = EXCLUDED.body, delay_days = EXCLUDED.delay_days
      WHERE outreach_channel_tasks.status = 'draft'
    `, [draftId, input.messenger_contact_id, draft.company_key, body, delay(input.messenger_delay_days)]);
    if (!rowCount) throw problem("company_sequence_messenger_unavailable");
  } else {
    await client.query("DELETE FROM outreach_channel_tasks WHERE draft_id = $1 AND status = 'draft'", [draftId]);
  }
  await client.query("UPDATE outreach_drafts SET company_sequence_enabled = true, updated_at = now() WHERE id = $1", [draftId]);
}

export async function companySequencePlan(query, draftId) {
  const { rows: [messenger] } = await query(`
    SELECT t.contact_id, t.body, t.delay_days, t.status, t.scheduled_at, c.channel, c.address, c.name
    FROM outreach_channel_tasks t JOIN outreach_channel_contacts c ON c.id = t.contact_id
    WHERE t.draft_id = $1
  `, [draftId]);
  return messenger || null;
}

export async function releaseCompanyMessengerTasks(client) {
  await lockOutreachQueueMutation(client);
  await client.query(`
    UPDATE outreach_channel_tasks t SET status = 'cancelled', completed_at = now()
    FROM outreach_drafts d
    WHERE t.draft_id = d.id AND t.status IN ('waiting', 'scheduled')
      AND (d.status IN ('paused','cancelled')
        OR EXISTS (SELECT 1 FROM sending_queue q WHERE q.outreach_draft_id = d.id
          AND q.status IN ('failed', 'cancelled')
          AND NOT EXISTS (SELECT 1 FROM sending_queue replacement
            WHERE replacement.outreach_step_id = q.outreach_step_id
              AND replacement.status IN ('pending', 'running', 'retrying', 'sent'))))
  `);
  return client.query(`
    UPDATE outreach_channel_tasks t
    SET status = CASE WHEN last_message.provider_message_id = 'dry-run' THEN 'cancelled' ELSE 'scheduled' END,
        scheduled_at = last_message.sent_at + make_interval(days => t.delay_days),
        completed_at = CASE WHEN last_message.provider_message_id = 'dry-run' THEN now() END
    FROM outreach_drafts d
    JOIN LATERAL (
      SELECT m.sent_at, m.provider_message_id
      FROM outreach_draft_steps s JOIN messages m ON m.id = s.sent_message_id
      WHERE s.draft_id = d.id AND s.status = 'sent' AND m.direction = 'outbound' AND m.type = 'outreach' AND m.status = 'sent'
        AND m.sent_at IS NOT NULL
        AND s.position = (SELECT max(step.position) FROM outreach_draft_steps step WHERE step.draft_id = d.id)
    ) last_message ON true
    WHERE t.draft_id = d.id AND t.status = 'waiting' AND d.status = 'completed'
  `);
}

export async function stopDeclinedCompanySequences(client, leadId) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [OUTREACH_DELIVERY_LOCK]);
  await client.query(`
    WITH affected AS (
      UPDATE outreach_drafts d SET status = 'cancelled', updated_at = now()
      FROM leads anchor, leads respondent
      WHERE respondent.id = $1 AND anchor.id = d.lead_id
        AND (anchor.id = respondent.id OR (btrim(anchor.company) <> '' AND lower(btrim(anchor.company)) = lower(btrim(respondent.company))))
        AND d.company_sequence_enabled AND d.status IN ('queued','active_sequence','paused')
      RETURNING d.id
    ), queue AS (
      UPDATE sending_queue q SET status = 'cancelled', last_error = 'Компания отказалась от контакта',
        quota_reservation_active = false, quota_reserved_at = NULL, updated_at = now()
      WHERE q.outreach_draft_id IN (SELECT id FROM affected) AND q.status IN ('pending','retrying','running')
    )
    UPDATE outreach_draft_steps s SET status = 'cancelled', updated_at = now()
    WHERE s.draft_id IN (SELECT id FROM affected) AND s.status <> 'sent'
  `, [leadId]);
}
