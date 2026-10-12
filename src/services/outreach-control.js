export const OUTREACH_MIN_SPACING_MINUTES = 2;
export const OUTREACH_DELIVERY_LOCK = "outreach_delivery_control";

export async function lockOutreachQueueMutation(client) {
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtext($1))", [OUTREACH_DELIVERY_LOCK]);
}

export async function withOutreachDeliveryLock(client, callback) {
  await client.query("SELECT pg_advisory_lock_shared(hashtext($1))", [OUTREACH_DELIVERY_LOCK]);
  try {
    return await callback(client);
  } finally {
    await client.query("SELECT pg_advisory_unlock_shared(hashtext($1))", [OUTREACH_DELIVERY_LOCK]);
  }
}

export async function outreachStopAllImpact(client) {
  const result = await client.query(
    `
      WITH active_queue AS (
        SELECT
          q.id,
          COALESCE(cs.position, ods.position, 1) AS step_position,
          q.mode
        FROM sending_queue q
        LEFT JOIN campaign_steps cs ON cs.id = q.campaign_step_id
        LEFT JOIN outreach_draft_steps ods ON ods.id = q.outreach_step_id
        WHERE q.status IN ('pending','retrying','running')
          AND q.mode <> 'test'
      ),
      active_runs AS (
        SELECT run.id
        FROM outreach_runs run
        WHERE run.status = 'active'
          AND run.mode <> 'test'
      ),
      active_enrollments AS (
        SELECT enrollment.id
        FROM enrollments enrollment
        JOIN campaigns campaign ON campaign.id = enrollment.campaign_id
        WHERE enrollment.status = 'active'
          AND COALESCE(
            (
              SELECT enrollment_queue.mode
              FROM sending_queue enrollment_queue
              WHERE enrollment_queue.enrollment_id = enrollment.id
              ORDER BY enrollment_queue.created_at DESC, enrollment_queue.id DESC
              LIMIT 1
            ),
            CASE WHEN campaign.test_mode THEN 'test' ELSE 'auto' END
          ) <> 'test'
      ),
      active_drafts AS (
        SELECT draft.id
        FROM outreach_drafts draft
        WHERE draft.status IN ('queued','active_sequence','paused')
      ),
      affected_entities AS (
        SELECT 'queue:' || id::text || ':step:' || step_position::text AS entity_key FROM active_queue
        UNION
        SELECT 'run:' || id::text FROM active_runs
        UNION
        SELECT 'enrollment:' || id::text FROM active_enrollments
        UNION
        SELECT 'draft:' || id::text FROM active_drafts
      )
      SELECT
        (SELECT count(*)::int FROM active_queue) AS active_queue,
        (SELECT count(*)::int FROM active_queue WHERE step_position <= 1) AS first_touches,
        (SELECT count(*)::int FROM active_queue WHERE step_position > 1) AS followups,
        (SELECT count(*)::int FROM active_runs) AS active_runs,
        (SELECT count(*)::int FROM active_enrollments) AS active_enrollments,
        (SELECT count(*)::int FROM active_drafts) AS active_drafts,
        md5(COALESCE(
          (SELECT string_agg(entity_key, ',' ORDER BY entity_key) FROM affected_entities),
          ''
        )) AS snapshot_token
    `,
  );
  return result.rows[0] || {
    active_queue: 0,
    first_touches: 0,
    followups: 0,
    active_runs: 0,
    active_enrollments: 0,
    active_drafts: 0,
    snapshot_token: "d41d8cd98f00b204e9800998ecf8427e",
  };
}

export async function stopAllOutreach(client, expectedSnapshotToken) {
  if (!expectedSnapshotToken) {
    const error = new Error("outreach_stop_snapshot_required");
    error.status = 400;
    throw error;
  }
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [OUTREACH_DELIVERY_LOCK]);
    const impact = await outreachStopAllImpact(client);
    if (impact.snapshot_token !== expectedSnapshotToken) {
      const error = new Error("outreach_stop_snapshot_changed");
      error.status = 409;
      throw error;
    }
    const cancelled = await client.query(
      `
        UPDATE sending_queue
        SET status = 'cancelled',
            last_error = 'Вся рассылка остановлена пользователем',
            quota_reservation_active = false,
            quota_reserved_at = NULL,
            updated_at = now()
        WHERE status IN ('pending','retrying','running')
          AND mode <> 'test'
        RETURNING outreach_step_id
      `,
    );
    const pausedEnrollments = await client.query(
      `
        UPDATE enrollments enrollment
        SET status = 'paused',
            stopped_at = now(),
            stop_reason = 'all_outreach_stopped_by_user'
        FROM campaigns campaign
        WHERE enrollment.status = 'active'
          AND campaign.id = enrollment.campaign_id
          AND COALESCE(
            (
              SELECT enrollment_queue.mode
              FROM sending_queue enrollment_queue
              WHERE enrollment_queue.enrollment_id = enrollment.id
              ORDER BY enrollment_queue.created_at DESC, enrollment_queue.id DESC
              LIMIT 1
            ),
            CASE WHEN campaign.test_mode THEN 'test' ELSE 'auto' END
          ) <> 'test'
      `,
    );
    const cancelledDrafts = await client.query(
      `
        UPDATE outreach_drafts
        SET status = 'cancelled',
            updated_at = now()
        WHERE status IN ('queued','active_sequence','paused')
        RETURNING id
      `,
    );
    const draftIds = cancelledDrafts.rows.map((row) => row.id).filter(Boolean);
    let cancelledSteps = 0;
    if (draftIds.length) {
      cancelledSteps = (await client.query(
        `
          UPDATE outreach_draft_steps
          SET status = 'cancelled',
              updated_at = now()
          WHERE draft_id = ANY($1::uuid[])
            AND status <> 'sent'
        `,
        [draftIds],
      )).rowCount;
    }
    const stoppedRuns = await client.query(
      `
        UPDATE outreach_runs
        SET status = 'stopped',
            updated_at = now()
        WHERE status = 'active'
          AND mode <> 'test'
      `,
    );
    await client.query("COMMIT");
    return {
      stopped: true,
      cancelled_queue: cancelled.rowCount,
      cancelled_steps: cancelledSteps,
      paused_enrollments: pausedEnrollments.rowCount,
      cancelled_drafts: cancelledDrafts.rowCount,
      stopped_runs: stoppedRuns.rowCount,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
