CREATE TABLE outreach_channel_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email_general', 'email_personal', 'telegram', 'max', 'vk')),
  address text NOT NULL,
  name text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT '',
  source_url text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lead_id, channel, address)
);

CREATE TABLE outreach_channel_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES outreach_channel_contacts(id) ON DELETE CASCADE,
  company_key text NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'sent', 'cancelled', 'replied', 'declined')),
  sent_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX outreach_channel_tasks_active_company
  ON outreach_channel_tasks(company_key) WHERE status = 'scheduled';

CREATE INDEX outreach_channel_tasks_schedule
  ON outreach_channel_tasks(status, scheduled_at);

CREATE INDEX outreach_channel_tasks_contact
  ON outreach_channel_tasks(contact_id);
