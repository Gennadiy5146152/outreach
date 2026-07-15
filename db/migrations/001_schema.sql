CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL,
  email text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'new',
  contact_name text,
  position text,
  website text,
  domain text,
  segment text,
  country text,
  city text,
  pain text,
  source text,
  notes text,
  validation_status text NOT NULL DEFAULT 'unknown',
  validation_reason text,
  last_validated_at timestamptz,
  suppressed_at timestamptz,
  suppression_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_status_idx ON leads(status);
CREATE INDEX IF NOT EXISTS leads_segment_idx ON leads(segment);
CREATE INDEX IF NOT EXISTS leads_validation_idx ON leads(validation_status);

CREATE TABLE IF NOT EXISTS mailboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  provider text NOT NULL DEFAULT 'custom',
  smtp_host text NOT NULL,
  smtp_port integer NOT NULL DEFAULT 465,
  smtp_secure boolean NOT NULL DEFAULT true,
  imap_host text NOT NULL,
  imap_port integer NOT NULL DEFAULT 993,
  imap_secure boolean NOT NULL DEFAULT true,
  username text,
  password_env_key text,
  from_name text,
  daily_send_limit integer,
  daily_warmup_limit integer NOT NULL DEFAULT 5,
  min_delay_minutes integer NOT NULL DEFAULT 7,
  max_delay_minutes integer NOT NULL DEFAULT 18,
  send_window_start time NOT NULL DEFAULT '09:00',
  send_window_end time NOT NULL DEFAULT '18:00',
  send_days integer[] NOT NULL DEFAULT ARRAY[1,2,3,4,5],
  is_active boolean NOT NULL DEFAULT true,
  warmup_enabled boolean NOT NULL DEFAULT false,
  smtp_verified_at timestamptz,
  imap_verified_at timestamptz,
  last_inbox_sync_at timestamptz,
  health_status text NOT NULL DEFAULT 'unknown',
  error_count integer NOT NULL DEFAULT 0,
  paused_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sending_domain_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id uuid REFERENCES mailboxes(id) ON DELETE CASCADE,
  domain text NOT NULL,
  mx_status text NOT NULL DEFAULT 'unknown',
  spf_status text NOT NULL DEFAULT 'unknown',
  dkim_status text NOT NULL DEFAULT 'unknown',
  dmarc_status text NOT NULL DEFAULT 'unknown',
  checked_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft',
  segment text,
  daily_limit integer,
  send_window_start time NOT NULL DEFAULT '09:00',
  send_window_end time NOT NULL DEFAULT '18:00',
  send_days integer[] NOT NULL DEFAULT ARRAY[1,2,3,4,5],
  min_delay_minutes integer NOT NULL DEFAULT 7,
  max_delay_minutes integer NOT NULL DEFAULT 18,
  tracking_enabled boolean NOT NULL DEFAULT true,
  manual_approval_required boolean NOT NULL DEFAULT true,
  test_mode boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaign_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  position integer NOT NULL,
  name text NOT NULL,
  delay_days integer NOT NULL DEFAULT 0,
  subject_template text NOT NULL,
  body_template_text text NOT NULL,
  body_template_html text NOT NULL,
  editor_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  attachments_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(campaign_id, position)
);

CREATE TABLE IF NOT EXISTS enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  mailbox_id uuid REFERENCES mailboxes(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active',
  current_step integer NOT NULL DEFAULT 1,
  next_send_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  stop_reason text,
  UNIQUE(lead_id, campaign_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  campaign_step_id uuid REFERENCES campaign_steps(id) ON DELETE SET NULL,
  mailbox_id uuid REFERENCES mailboxes(id) ON DELETE SET NULL,
  enrollment_id uuid REFERENCES enrollments(id) ON DELETE SET NULL,
  direction text NOT NULL,
  type text NOT NULL DEFAULT 'outreach',
  reply_classification text,
  reply_classification_source text,
  status text NOT NULL DEFAULT 'created',
  subject text NOT NULL,
  body_text text,
  body_html text,
  provider_message_id text,
  message_id_header text,
  in_reply_to text,
  references_header text,
  tracking_id uuid UNIQUE,
  raw_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  sent_at timestamptz,
  received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_tracking_idx ON messages(tracking_id);
CREATE INDEX IF NOT EXISTS messages_message_id_header_idx ON messages(message_id_header);
CREATE INDEX IF NOT EXISTS messages_lead_idx ON messages(lead_id);

CREATE TABLE IF NOT EXISTS attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_step_id uuid REFERENCES campaign_steps(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  storage_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  mailbox_id uuid REFERENCES mailboxes(id) ON DELETE SET NULL,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_type_idx ON events(event_type);
CREATE INDEX IF NOT EXISTS events_created_idx ON events(created_at);

CREATE TABLE IF NOT EXISTS email_validation_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,
  email text NOT NULL,
  status text NOT NULL,
  reason text,
  syntax_valid boolean NOT NULL DEFAULT false,
  domain_exists boolean NOT NULL DEFAULT false,
  mx_exists boolean NOT NULL DEFAULT false,
  provider text,
  is_disposable boolean NOT NULL DEFAULT false,
  is_role_based boolean NOT NULL DEFAULT false,
  is_catch_all boolean,
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  domain text,
  reason text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR domain IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS suppressions_email_unique ON suppressions(lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS suppressions_domain_unique ON suppressions(lower(domain)) WHERE domain IS NOT NULL;

CREATE TABLE IF NOT EXISTS open_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  tracking_id uuid NOT NULL,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  mailbox_id uuid REFERENCES mailboxes(id) ON DELETE SET NULL,
  ip text,
  user_agent text,
  is_first_open boolean NOT NULL DEFAULT false,
  is_proxy_like boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS open_events_tracking_idx ON open_events(tracking_id);

CREATE TABLE IF NOT EXISTS sending_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id uuid REFERENCES enrollments(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  campaign_step_id uuid REFERENCES campaign_steps(id) ON DELETE SET NULL,
  mailbox_id uuid REFERENCES mailboxes(id) ON DELETE SET NULL,
  mode text NOT NULL DEFAULT 'manual',
  status text NOT NULL DEFAULT 'pending',
  requires_approval boolean NOT NULL DEFAULT true,
  approved_at timestamptz,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  last_error text,
  sent_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sending_queue_status_idx ON sending_queue(status, scheduled_at);

CREATE TABLE IF NOT EXISTS job_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_queue_ready_idx ON job_queue(status, run_at);

CREATE TABLE IF NOT EXISTS imap_sync_state (
  mailbox_id uuid PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
  folder text NOT NULL DEFAULT 'INBOX',
  last_uid bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS warmup_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_mailbox_id uuid REFERENCES mailboxes(id) ON DELETE CASCADE,
  to_mailbox_id uuid REFERENCES mailboxes(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active',
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings(key, value)
VALUES
  ('sender', '{"senderOffer":"помочь B2B-командам находить клиентов через аккуратный email-аутрич"}'),
  ('runtime', '{"dryRun":true,"publicTrackingUrl":"","maxAttachmentMb":50}'),
  ('tracking', '{"publicTrackingUrl":""}'),
  ('attachments', '{"maxAttachmentMb":50}')
ON CONFLICT (key) DO NOTHING;
