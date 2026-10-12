export const OUTREACH_MIN_SPACING_MINUTES = 2;

export async function outreachStopAllImpact(client) {
  const result = await client.query(
    `
      WITH active_queue AS (
        SELECT
          q.id,
          COALESCE(cs.position, ods.position, 1) AS step_position
        FROM sending_queue q
        LEFT JOIN campaign_steps cs ON cs.id = q.campaign_step_id
        LEFT JOIN outreach_draft_steps ods ON ods.id = q.outreach_step_id
        WHERE q.status IN ('pending','retrying','running')
          AND q.mode <> 'test'
      )
      SELECT
        (SELECT count(*)::int FROM active_queue) AS active_queue,
        (SELECT count(*)::int FROM active_queue WHERE step_position <= 1) AS first_touches,
        (SELECT count(*)::int FROM active_queue WHERE step_position > 1) AS followups,
        (
          SELECT count(*)::int
          FROM outreach_runs run
          WHERE run.status = 'active'
            AND run.mode <> 'test'
        ) AS active_runs,
        (
          SELECT count(*)::int
          FROM enrollments enrollment
          JOIN campaigns campaign ON campaign.id = enrollment.campaign_id
          WHERE enrollment.status = 'active'
            AND (
              campaign.test_mode = false
              OR EXISTS (
                SELECT 1
                FROM sending_queue enrollment_queue
                WHERE enrollment_queue.enrollment_id = enrollment.id
                  AND enrollment_queue.mode <> 'test'
              )
            )
        ) AS active_enrollments,
        (
          SELECT count(*)::int
          FROM outreach_drafts
          WHERE status IN ('queued','active_sequence','paused')
        ) AS active_drafts
    `,
  );
  return result.rows[0] || {
    active_queue: 0,
    first_touches: 0,
    followups: 0,
    active_runs: 0,
    active_enrollments: 0,
    active_drafts: 0,
  };
}

export async function stopAllOutreach(client) {
  await client.query("BEGIN");
  try {
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
          AND (
            campaign.test_mode = false
            OR EXISTS (
              SELECT 1
              FROM sending_queue enrollment_queue
              WHERE enrollment_queue.enrollment_id = enrollment.id
                AND enrollment_queue.mode <> 'test'
            )
          )
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
