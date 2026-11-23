ALTER TABLE outreach_telegram_profiles ADD COLUMN IF NOT EXISTS day_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE outreach_telegram_deliveries ADD COLUMN IF NOT EXISTS send_before timestamptz;
