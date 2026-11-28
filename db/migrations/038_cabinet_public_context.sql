ALTER TABLE cabinet_drafts DROP CONSTRAINT cabinet_drafts_permission_kind_check;
ALTER TABLE cabinet_drafts ADD CONSTRAINT cabinet_drafts_permission_kind_check
  CHECK (permission_kind IN ('request','consent','public_context'));
ALTER TABLE cabinet_drafts DROP CONSTRAINT IF EXISTS cabinet_drafts_public_context_check;
ALTER TABLE cabinet_drafts ADD CONSTRAINT cabinet_drafts_public_context_check CHECK (
  CASE WHEN permission_kind IS DISTINCT FROM 'public_context' THEN true ELSE (
    source_url ~ '^https://t[.]me/[A-Za-z][A-Za-z0-9_]{4,31}/[1-9][0-9]*$'
    AND length(btrim(permission_evidence)) >= 30
    AND position(source_url IN permission_evidence) > 0
    AND CASE WHEN ltrim(permission_evidence) LIKE '{%'
      THEN jsonb_typeof(permission_evidence::jsonb) = 'object'
        AND permission_evidence::jsonb ?& ARRAY['date','quote','source_url']
        AND jsonb_typeof(permission_evidence::jsonb->'date') = 'string'
        AND permission_evidence::jsonb->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        AND jsonb_typeof(permission_evidence::jsonb->'quote') = 'string'
        AND length(btrim(permission_evidence::jsonb->>'quote')) >= 10
        AND permission_evidence::jsonb->>'source_url' = source_url
      ELSE false END
  ) END
);
ALTER TABLE cabinet_jobs ADD COLUMN one_off_mode text,
  ADD CONSTRAINT cabinet_jobs_one_off_mode_check CHECK (
    one_off_mode IS NULL OR (one_off_mode='today_batch' AND one_off_day IS NOT NULL AND one_off_daily_limit<=20)
  );
