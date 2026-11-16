CREATE TABLE outreach_telegram_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL REFERENCES outreach_messenger_drafts(id),
  sender text NOT NULL,
  recipient_id bigint NOT NULL CHECK (recipient_id > 0),
  address text NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  permission_kind text NOT NULL CHECK (permission_kind IN ('request', 'consent')),
  permission_evidence text NOT NULL CHECK (char_length(btrim(permission_evidence)) BETWEEN 3 AND 1000),
  scheduled_at timestamptz NOT NULL,
  random_id bigint NOT NULL UNIQUE CHECK (random_id > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed', 'uncertain', 'cancelled')),
  attempted_at timestamptz,
  completed_at timestamptz,
  telegram_message_id integer,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'sent') = (telegram_message_id IS NOT NULL)),
  CHECK ((scheduled_at AT TIME ZONE 'Europe/Moscow')::time >= time '09:30'
    AND (scheduled_at AT TIME ZONE 'Europe/Moscow')::time < time '11:30')
);

CREATE UNIQUE INDEX outreach_telegram_active_recipient_idx
  ON outreach_telegram_deliveries(recipient_id) WHERE status IN ('pending', 'sending', 'uncertain');
CREATE UNIQUE INDEX outreach_telegram_active_address_idx
  ON outreach_telegram_deliveries(address) WHERE status IN ('pending', 'sending', 'uncertain');
CREATE UNIQUE INDEX outreach_telegram_active_draft_idx
  ON outreach_telegram_deliveries(draft_id) WHERE status IN ('pending', 'sending', 'uncertain');
CREATE INDEX outreach_telegram_queue_idx ON outreach_telegram_deliveries(sender, status, scheduled_at);
