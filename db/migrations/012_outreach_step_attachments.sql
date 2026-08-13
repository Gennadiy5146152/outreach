ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS outreach_step_id uuid REFERENCES outreach_draft_steps(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS attachments_outreach_step_idx ON attachments(outreach_step_id);
