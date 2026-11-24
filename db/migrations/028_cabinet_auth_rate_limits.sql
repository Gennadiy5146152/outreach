CREATE TABLE cabinet_auth_rate_limits (
  bucket_hash text PRIMARY KEY,
  attempts integer NOT NULL CHECK (attempts > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX cabinet_auth_rate_limits_expiry ON cabinet_auth_rate_limits(expires_at);
