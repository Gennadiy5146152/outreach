ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ai_classification text,
  ADD COLUMN IF NOT EXISTS ai_confidence numeric(5,4),
  ADD COLUMN IF NOT EXISTS ai_reason text,
  ADD COLUMN IF NOT EXISTS ai_model text,
  ADD COLUMN IF NOT EXISTS ai_usage jsonb,
  ADD COLUMN IF NOT EXISTS ai_analyzed_at timestamptz,
  ADD COLUMN IF NOT EXISTS ai_error text;

CREATE INDEX IF NOT EXISTS messages_ai_classification_idx ON messages(ai_classification);
