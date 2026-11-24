import { digest, fail } from "./security.js";

// Only hashed bucket identifiers are persisted. Limits survive web restarts and work across replicas.
export function createAuthRateLimiter({ query, now = Date.now }) {
  let cleanupAt = 0;
  return async function consume(scope, identity, maximum = 10) {
    let row;
    try {
      if (now() >= cleanupAt) {
        cleanupAt = now() + 60000;
        await query(
          "DELETE FROM cabinet_auth_rate_limits WHERE expires_at<=now()",
        );
      }
      row = (
        await query(
          `
        INSERT INTO cabinet_auth_rate_limits(bucket_hash,attempts,expires_at)
        VALUES($1,1,now()+interval '15 minutes')
        ON CONFLICT(bucket_hash) DO UPDATE SET
          attempts=CASE WHEN cabinet_auth_rate_limits.expires_at<=now() THEN 1 ELSE LEAST(cabinet_auth_rate_limits.attempts+1,$2+1) END,
          expires_at=CASE WHEN cabinet_auth_rate_limits.expires_at<=now() THEN now()+interval '15 minutes' ELSE cabinet_auth_rate_limits.expires_at END
        RETURNING attempts,expires_at`,
          [digest("auth:" + scope + ":" + String(identity)), maximum],
        )
      ).rows[0];
    } catch {
      throw fail("auth_temporarily_unavailable", 503);
    }
    if (row.attempts > maximum)
      throw Object.assign(fail("too_many_requests", 429), {
        retryAfter: Math.max(
          1,
          Math.ceil((new Date(row.expires_at).getTime() - now()) / 1000),
        ),
      });
  };
}
