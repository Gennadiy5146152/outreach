-- Source identity is separate from mutable research source_url. Null preserves
-- existing username recipients, including historical fixture address shapes.
CREATE FUNCTION cabinet_recipient_source_valid(value jsonb, recipient bigint, address text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN value IS NULL THEN true
    WHEN jsonb_typeof(value) <> 'object' THEN false
    ELSE coalesce(
      value ?& ARRAY['chat_id','username','message_id']
      AND value - ARRAY['chat_id','username','message_id']::text[] = '{}'::jsonb
      AND jsonb_typeof(value->'chat_id') = 'string'
      AND (value->>'chat_id') ~ '^[1-9][0-9]{0,18}$'
      AND CASE WHEN (value->>'chat_id') ~ '^[1-9][0-9]{0,18}$'
        THEN (value->>'chat_id')::numeric <= 9223372036854775807 ELSE false END
      AND jsonb_typeof(value->'username') = 'string'
      AND (value->>'username') ~ '^[a-z][a-z0-9_]{4,31}$'
      AND CASE WHEN jsonb_typeof(value->'message_id') = 'number'
        THEN (value->>'message_id')::numeric BETWEEN 1 AND 2147483647
          AND (value->>'message_id')::numeric = trunc((value->>'message_id')::numeric)
        ELSE false END
      AND recipient > 0 AND address = 'tg://user?id=' || recipient::text,
      false)
    END
$$;

ALTER TABLE cabinet_drafts ADD COLUMN recipient_source jsonb,
  ADD CONSTRAINT cabinet_drafts_recipient_source_check
    CHECK (cabinet_recipient_source_valid(recipient_source,recipient_id,address));
ALTER TABLE cabinet_jobs ADD COLUMN recipient_source jsonb,
  ADD CONSTRAINT cabinet_jobs_recipient_source_check
    CHECK (cabinet_recipient_source_valid(recipient_source,recipient_id,address));
