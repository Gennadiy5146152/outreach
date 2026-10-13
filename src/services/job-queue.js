export const DELIVERY_JOB_TYPES = Object.freeze(["validate_lead", "sync_inbox", "warmup_send"]);
export const PERSONALIZATION_JOB_TYPES = Object.freeze(["enrich_lead", "generate_personalized_draft"]);

function requireJobTypes(jobTypes) {
  if (!Array.isArray(jobTypes) || !jobTypes.length || jobTypes.some((type) => !String(type || "").trim())) {
    throw new Error("job_types_required");
  }
  return [...new Set(jobTypes.map(String))];
}

export async function claimJob(client, { jobTypes } = {}) {
  const allowed = requireJobTypes(jobTypes);
  await client.query("BEGIN");
  try {
    const result = await client.query(
      `
        SELECT *
        FROM job_queue
        WHERE job_type = ANY($1::text[])
          AND status IN ('pending','retrying')
          AND run_at <= now()
        ORDER BY run_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `,
      [allowed],
    );
    if (!result.rowCount) {
      await client.query("COMMIT");
      return null;
    }
    const job = result.rows[0];
    await client.query(
      "UPDATE job_queue SET status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now() WHERE id = $1",
      [job.id],
    );
    await client.query("COMMIT");
    return job;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function finishJob(client, jobId) {
  await client.query(
    "UPDATE job_queue SET status = 'done', last_error = NULL, locked_at = NULL, updated_at = now() WHERE id = $1",
    [jobId],
  );
}

export async function failJob(client, job, error) {
  const nextAttempt = Number(job.attempts || 0) + 1;
  const retry = nextAttempt < Number(job.max_attempts || 3);
  await client.query(
    `
      UPDATE job_queue
      SET status = $2,
          run_at = now() + (($3 * 5) || ' minutes')::interval,
          last_error = $4,
          locked_at = NULL,
          updated_at = now()
      WHERE id = $1
    `,
    [job.id, retry ? "retrying" : "failed", nextAttempt, error?.message || String(error)],
  );
  return { retry, attempts: nextAttempt };
}
