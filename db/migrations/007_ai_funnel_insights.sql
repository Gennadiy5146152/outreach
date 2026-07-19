ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ai_funnel_stage text,
  ADD COLUMN IF NOT EXISTS ai_lead_temperature text,
  ADD COLUMN IF NOT EXISTS ai_reply_reason text,
  ADD COLUMN IF NOT EXISTS ai_next_best_action text,
  ADD COLUMN IF NOT EXISTS ai_summary text;

ALTER TABLE outreach_conversations
  ADD COLUMN IF NOT EXISTS funnel_stage text,
  ADD COLUMN IF NOT EXISTS lead_temperature text,
  ADD COLUMN IF NOT EXISTS reply_reason text,
  ADD COLUMN IF NOT EXISTS ai_next_best_action text,
  ADD COLUMN IF NOT EXISTS ai_reason text,
  ADD COLUMN IF NOT EXISTS ai_confidence numeric(5,4),
  ADD COLUMN IF NOT EXISTS ai_updated_at timestamptz;

CREATE INDEX IF NOT EXISTS messages_ai_funnel_stage_idx ON messages(ai_funnel_stage);
CREATE INDEX IF NOT EXISTS outreach_conversations_funnel_stage_idx ON outreach_conversations(funnel_stage);
CREATE INDEX IF NOT EXISTS outreach_conversations_lead_temperature_idx ON outreach_conversations(lead_temperature);
