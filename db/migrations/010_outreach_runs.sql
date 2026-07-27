CREATE TABLE IF NOT EXISTS outreach_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text NOT NULL DEFAULT 'manual',
  source_id uuid,
  title text NOT NULL,
  mode text NOT NULL DEFAULT 'manual',
  status text NOT NULL DEFAULT 'active',
  total_recipients integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sending_queue
  ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES outreach_runs(id) ON DELETE SET NULL;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES outreach_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS outreach_runs_created_idx ON outreach_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS sending_queue_run_idx ON sending_queue(run_id, lead_id);
CREATE INDEX IF NOT EXISTS messages_run_idx ON messages(run_id, lead_id);
