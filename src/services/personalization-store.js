function uniqueLeadIds(leadIds = []) {
  return [...new Set(leadIds.filter(Boolean))];
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

export async function createPilot(client, {
  limit,
  rulesVersion,
  leadIds,
  selectionToken,
  enqueueJobType,
}) {
  const uniqueIds = uniqueLeadIds(leadIds);
  if (!uniqueIds.length) throw new Error("personalization_pilot_requires_leads");
  if (!Number.isInteger(limit) || limit < 1 || limit > 30 || uniqueIds.length > limit) {
    throw new Error("personalization_pilot_limit_invalid");
  }

  return transaction(client, async () => {
    const importRow = (await client.query(
      `
        INSERT INTO outreach_imports(file_name, file_type, status, rows_total, rows_ready, rows_blocked, rows_skipped, completed_at)
        VALUES ($1, 'personalization', 'processing', $2, 0, 0, 0, NULL)
        RETURNING id
      `,
      [`Персонализация: пилот ${new Date().toISOString()}`, uniqueIds.length],
    )).rows[0];
    const pilot = (await client.query(
      `
        INSERT INTO personalization_pilots(outreach_import_id, status, requested_limit, rules_version, selection_token)
        VALUES ($1, 'running', $2, $3, $4)
        RETURNING *
      `,
      [importRow.id, limit, rulesVersion, selectionToken],
    )).rows[0];
    await client.query(
      `
        INSERT INTO personalization_pilot_items(pilot_id, lead_id, source_row_number)
        SELECT $1, selected.lead_id, selected.ordinality::int
        FROM unnest($2::uuid[]) WITH ORDINALITY AS selected(lead_id, ordinality)
        ON CONFLICT (pilot_id, lead_id) DO NOTHING
      `,
      [pilot.id, uniqueIds],
    );
    if (enqueueJobType) {
      await client.query(
        `
          INSERT INTO job_queue(job_type, payload)
          SELECT $2, jsonb_build_object(
            'itemId', item.id::text,
            'pilotId', item.pilot_id::text,
            'rulesVersion', $3::text
          )
          FROM personalization_pilot_items item
          WHERE item.pilot_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM job_queue job
              WHERE job.job_type = $2
                AND job.payload->>'itemId' = item.id::text
            )
        `,
        [pilot.id, enqueueJobType, rulesVersion],
      );
    }
    return pilot;
  });
}

export async function upsertEnrichment(client, input) {
  const result = await client.query(
    `
      INSERT INTO lead_enrichments(
        lead_id, status, fit_score, fit_reason, canonical_company, business_type, city,
        contact_name, contact_position, contact_confidence, alternative_contacts,
        personalization_fact, fact_source_url, fact_evidence, source_pages,
        rules_version, model, prompt_version, last_error, processed_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,now())
      ON CONFLICT (lead_id, rules_version) DO UPDATE SET
        status = EXCLUDED.status,
        fit_score = EXCLUDED.fit_score,
        fit_reason = EXCLUDED.fit_reason,
        canonical_company = EXCLUDED.canonical_company,
        business_type = EXCLUDED.business_type,
        city = EXCLUDED.city,
        contact_name = EXCLUDED.contact_name,
        contact_position = EXCLUDED.contact_position,
        contact_confidence = EXCLUDED.contact_confidence,
        alternative_contacts = EXCLUDED.alternative_contacts,
        personalization_fact = EXCLUDED.personalization_fact,
        fact_source_url = EXCLUDED.fact_source_url,
        fact_evidence = EXCLUDED.fact_evidence,
        source_pages = EXCLUDED.source_pages,
        model = EXCLUDED.model,
        prompt_version = EXCLUDED.prompt_version,
        last_error = EXCLUDED.last_error,
        processed_at = now(),
        updated_at = now()
      RETURNING *
    `,
    [
      input.leadId,
      input.status,
      Number(input.fitScore || 0),
      input.fitReason || "",
      input.canonicalCompany || null,
      input.businessType || null,
      input.city || null,
      input.contactName || null,
      input.contactPosition || null,
      input.contactConfidence ?? null,
      JSON.stringify(input.alternativeContacts || []),
      input.personalizationFact || null,
      input.factSourceUrl || null,
      input.factEvidence || null,
      JSON.stringify(input.sourcePages || []),
      input.rulesVersion,
      input.model || null,
      input.promptVersion || null,
      input.lastError || null,
    ],
  );
  return result.rows[0];
}

export async function getPilot(client, pilotId) {
  const pilot = (await client.query(
    "SELECT * FROM personalization_pilots WHERE id = $1",
    [pilotId],
  )).rows[0] || null;
  if (!pilot) return { pilot: null, items: [] };
  const items = (await client.query(
    `
      SELECT item.*, lead.company, lead.email, lead.website, lead.segment, lead.city,
             enrichment.fit_score, enrichment.fit_reason, enrichment.canonical_company,
             enrichment.contact_name AS enriched_contact_name,
             enrichment.contact_position AS enriched_contact_position,
             enrichment.contact_confidence, enrichment.alternative_contacts,
             enrichment.personalization_fact,
             enrichment.fact_source_url, enrichment.fact_evidence,
             enrichment.source_pages,
             draft.subject, draft.body_text, draft.manually_edited_at,
             draft_steps.steps AS draft_steps
      FROM personalization_pilot_items item
      JOIN leads lead ON lead.id = item.lead_id
      LEFT JOIN lead_enrichments enrichment ON enrichment.id = item.lead_enrichment_id
      LEFT JOIN outreach_drafts draft ON draft.id = item.draft_id
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
          'position', step.position,
          'subject', step.subject,
          'bodyText', step.body_text,
          'delayDays', step.delay_days,
          'status', step.status
        ) ORDER BY step.position) AS steps
        FROM outreach_draft_steps step
        WHERE step.draft_id = draft.id
      ) draft_steps ON true
      WHERE item.pilot_id = $1
      ORDER BY item.source_row_number
    `,
    [pilotId],
  )).rows;
  return { pilot, items };
}

export async function createDraftFromPersonalization(client, {
  pilotId,
  lead,
  enrichment,
  copy,
  sourceRowNumber,
}) {
  return transaction(client, async () => {
    const item = (await client.query(
      `
        SELECT status, draft_id
        FROM personalization_pilot_items
        WHERE pilot_id = $1 AND lead_id = $2
        FOR UPDATE
      `,
      [pilotId, lead.id],
    )).rows[0];
    if (!item) throw new Error("personalization_item_not_found");
    if (["review", "excluded"].includes(item.status)) {
      return { draftId: item.draft_id || null, created: false, skipped: true };
    }

    const existing = (await client.query(
      "SELECT id, manually_edited_at FROM outreach_drafts WHERE lead_enrichment_id = $1",
      [enrichment.id],
    )).rows[0];
    if (existing) return { draftId: existing.id, created: false };

    const pilot = (await client.query(
      "SELECT outreach_import_id FROM personalization_pilots WHERE id = $1",
      [pilotId],
    )).rows[0];
    if (!pilot) throw new Error("personalization_pilot_not_found");

    const rawRow = {
      personalization: true,
      pilot_id: pilotId,
      enrichment_id: enrichment.id,
      rules_version: enrichment.rules_version,
      used_evidence: copy.usedEvidence || [],
    };
    const inserted = await client.query(
      `
        INSERT INTO outreach_drafts(
          import_id, source_row_number, lead_id, to_email, company, contact_name,
          segment, subject, body_text, status, raw_row, lead_enrichment_id
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10::jsonb,$11)
        ON CONFLICT (lead_enrichment_id) DO NOTHING
        RETURNING id
      `,
      [
        pilot.outreach_import_id,
        sourceRowNumber,
        lead.id,
        lead.email,
        lead.company || "",
        lead.contact_name || "",
        lead.segment || "",
        copy.subject,
        copy.bodyText,
        JSON.stringify(rawRow),
        enrichment.id,
      ],
    );
    let draftId = inserted.rows[0]?.id;
    if (!draftId) {
      draftId = (await client.query(
        "SELECT id FROM outreach_drafts WHERE lead_enrichment_id = $1",
        [enrichment.id],
      )).rows[0]?.id;
      return { draftId, created: false };
    }

    await client.query(
      `
        INSERT INTO outreach_draft_steps(draft_id, position, subject, body_text, delay_days, status)
        VALUES
          ($1, 1, $2, $3, 0, 'ready'),
          ($1, 2, $4, $5, 2, 'ready')
        ON CONFLICT (draft_id, position) DO NOTHING
      `,
      [draftId, copy.subject, copy.bodyText, copy.followupSubject, copy.followupBodyText],
    );
    await client.query(
      `
        UPDATE personalization_pilot_items
        SET status = 'ready', draft_id = $3, lead_enrichment_id = $4, last_error = NULL, updated_at = now()
        WHERE pilot_id = $1 AND lead_id = $2
      `,
      [pilotId, lead.id, draftId, enrichment.id],
    );
    return { draftId, created: true };
  });
}
