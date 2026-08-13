ALTER TABLE outreach_drafts
  ADD COLUMN IF NOT EXISTS body_html text;

ALTER TABLE outreach_draft_steps
  ADD COLUMN IF NOT EXISTS body_html text;
