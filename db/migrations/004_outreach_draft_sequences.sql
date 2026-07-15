CREATE TABLE IF NOT EXISTS outreach_draft_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL REFERENCES outreach_drafts(id) ON DELETE CASCADE,
  position integer NOT NULL,
  subject text NOT NULL DEFAULT '',
  body_text text NOT NULL DEFAULT '',
  delay_days integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  queue_id uuid REFERENCES sending_queue(id) ON DELETE SET NULL,
  sent_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(draft_id, position)
);

ALTER TABLE sending_queue
  ADD COLUMN IF NOT EXISTS outreach_draft_id uuid REFERENCES outreach_drafts(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS outreach_step_id uuid REFERENCES outreach_draft_steps(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS subject_override text,
  ADD COLUMN IF NOT EXISTS body_text_override text,
  ADD COLUMN IF NOT EXISTS body_html_override text;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS outreach_draft_id uuid REFERENCES outreach_drafts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS outreach_step_id uuid REFERENCES outreach_draft_steps(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS outreach_draft_steps_draft_idx ON outreach_draft_steps(draft_id, position);
CREATE INDEX IF NOT EXISTS sending_queue_outreach_draft_idx ON sending_queue(outreach_draft_id, outreach_step_id);
CREATE INDEX IF NOT EXISTS messages_outreach_draft_idx ON messages(outreach_draft_id, outreach_step_id);
