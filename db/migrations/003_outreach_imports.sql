CREATE TABLE IF NOT EXISTS outreach_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name text NOT NULL,
  file_type text NOT NULL,
  status text NOT NULL DEFAULT 'completed',
  rows_total integer NOT NULL DEFAULT 0,
  rows_ready integer NOT NULL DEFAULT 0,
  rows_blocked integer NOT NULL DEFAULT 0,
  rows_skipped integer NOT NULL DEFAULT 0,
  error_report jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS outreach_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  email text NOT NULL,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  import_id uuid REFERENCES outreach_imports(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active_sequence',
  classification text,
  last_message_at timestamptz,
  next_action text,
  ai_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(email, campaign_id)
);

CREATE TABLE IF NOT EXISTS outreach_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid REFERENCES outreach_imports(id) ON DELETE SET NULL,
  source_row_number integer NOT NULL,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES outreach_conversations(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  mailbox_id uuid REFERENCES mailboxes(id) ON DELETE SET NULL,
  to_email text NOT NULL,
  company text,
  contact_name text,
  segment text,
  subject text NOT NULL DEFAULT '',
  body_text text NOT NULL DEFAULT '',
  send_after timestamptz,
  status text NOT NULL DEFAULT 'draft',
  error_reason text,
  raw_row jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outreach_imports_created_idx ON outreach_imports(created_at DESC);
CREATE INDEX IF NOT EXISTS outreach_drafts_status_idx ON outreach_drafts(status);
CREATE INDEX IF NOT EXISTS outreach_drafts_import_idx ON outreach_drafts(import_id);
CREATE INDEX IF NOT EXISTS outreach_drafts_email_idx ON outreach_drafts(lower(to_email));
CREATE INDEX IF NOT EXISTS outreach_conversations_status_idx ON outreach_conversations(status);
CREATE INDEX IF NOT EXISTS outreach_conversations_email_idx ON outreach_conversations(lower(email));
