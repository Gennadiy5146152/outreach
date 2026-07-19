ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS ai_campaign_summary text,
  ADD COLUMN IF NOT EXISTS ai_best_segments jsonb,
  ADD COLUMN IF NOT EXISTS ai_top_objections jsonb,
  ADD COLUMN IF NOT EXISTS ai_recommended_changes jsonb,
  ADD COLUMN IF NOT EXISTS ai_analyzed_at timestamptz;

ALTER TABLE outreach_imports
  ADD COLUMN IF NOT EXISTS ai_campaign_summary text,
  ADD COLUMN IF NOT EXISTS ai_best_segments jsonb,
  ADD COLUMN IF NOT EXISTS ai_top_objections jsonb,
  ADD COLUMN IF NOT EXISTS ai_recommended_changes jsonb,
  ADD COLUMN IF NOT EXISTS ai_analyzed_at timestamptz;
