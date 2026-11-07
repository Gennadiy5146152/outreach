ALTER TABLE outreach_drafts ADD COLUMN company_sequence_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE outreach_draft_steps
  ADD COLUMN recipient_lead_id uuid REFERENCES leads(id) ON DELETE RESTRICT,
  ADD COLUMN recipient_email text,
  ADD CONSTRAINT outreach_step_alternate_recipient CHECK (
    (recipient_lead_id IS NULL AND recipient_email IS NULL)
    OR (position = 3 AND recipient_lead_id IS NOT NULL AND recipient_email IS NOT NULL)
  );

ALTER TABLE outreach_channel_tasks
  ADD COLUMN draft_id uuid UNIQUE REFERENCES outreach_drafts(id) ON DELETE CASCADE,
  ADD COLUMN delay_days integer CHECK (delay_days BETWEEN 1 AND 90),
  ALTER COLUMN scheduled_at DROP NOT NULL,
  DROP CONSTRAINT outreach_channel_tasks_status_check,
  ADD CONSTRAINT outreach_channel_tasks_status_check
    CHECK (status IN ('draft', 'waiting', 'scheduled', 'sent', 'cancelled', 'replied', 'declined')),
  ADD CONSTRAINT outreach_channel_tasks_draft_schedule
    CHECK ((draft_id IS NOT NULL AND delay_days IS NOT NULL) OR
      (draft_id IS NULL AND delay_days IS NULL AND scheduled_at IS NOT NULL)),
  ADD CONSTRAINT outreach_channel_tasks_scheduled_at_required
    CHECK (status NOT IN ('scheduled', 'sent') OR scheduled_at IS NOT NULL);

DROP INDEX outreach_channel_tasks_active_company;
CREATE UNIQUE INDEX outreach_channel_tasks_active_company
  ON outreach_channel_tasks(company_key) WHERE status IN ('waiting', 'scheduled');
