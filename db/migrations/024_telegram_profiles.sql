CREATE TABLE outreach_telegram_profiles (
  sender text PRIMARY KEY CHECK (sender ~ '^[a-z][a-z0-9_]{3,31}$'),
  label text NOT NULL DEFAULT '',
  paused boolean NOT NULL DEFAULT true,
  daily_limit integer NOT NULL DEFAULT 10 CHECK (daily_limit BETWEEN 1 AND 100),
  window_start time NOT NULL DEFAULT '09:30',
  window_end time NOT NULL DEFAULT '11:30',
  revision integer NOT NULL DEFAULT 1,
  connection_status text NOT NULL DEFAULT 'awaiting_session'
    CHECK (connection_status IN ('awaiting_session','connected','error')),
  telegram_user_id bigint UNIQUE,
  heartbeat_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end > window_start),
  CHECK (extract(epoch FROM (window_end - window_start)) >= daily_limit * 180)
);

INSERT INTO outreach_telegram_profiles(sender, label, paused)
  SELECT DISTINCT sender, '@' || sender, false FROM outreach_telegram_deliveries;

ALTER TABLE outreach_telegram_deliveries ADD CONSTRAINT telegram_delivery_profile_fk
  FOREIGN KEY (sender) REFERENCES outreach_telegram_profiles(sender);

-- Schedule windows now belong to each profile. Retain all historical rows.
DO $$ DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'outreach_telegram_deliveries'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%09:30%'
  LOOP
    EXECUTE format('ALTER TABLE outreach_telegram_deliveries DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;
