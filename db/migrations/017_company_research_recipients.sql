CREATE TABLE IF NOT EXISTS company_research_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_run_id uuid NOT NULL REFERENCES company_research_runs(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  email text NOT NULL,
  normalized_email text NOT NULL,
  status text NOT NULL DEFAULT 'candidate',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (research_run_id, normalized_email),
  CHECK (normalized_email = lower(btrim(email))),
  CHECK (status IN ('candidate', 'drafted', 'excluded'))
);

CREATE INDEX IF NOT EXISTS company_research_recipients_run_idx
  ON company_research_recipients(research_run_id, status);

ALTER TABLE company_research_drafts
  ADD COLUMN IF NOT EXISTS recipient_id uuid REFERENCES company_research_recipients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS company_research_drafts_recipient_idx
  ON company_research_drafts(recipient_id);
