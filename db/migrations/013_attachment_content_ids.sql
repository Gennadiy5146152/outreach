ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS content_id text;

CREATE UNIQUE INDEX IF NOT EXISTS attachments_content_id_unique
  ON attachments(content_id)
  WHERE content_id IS NOT NULL;
