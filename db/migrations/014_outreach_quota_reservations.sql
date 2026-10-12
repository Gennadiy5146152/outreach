ALTER TABLE sending_queue
  ADD COLUMN IF NOT EXISTS quota_reservation_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS quota_reserved_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_sending_queue_active_quota_reservations
  ON sending_queue(mailbox_id, campaign_id, quota_reserved_at)
  WHERE quota_reservation_active = true;
