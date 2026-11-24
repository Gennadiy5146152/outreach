-- New tenant-owned Telegram data is separate from the legacy shared workspace.
CREATE TABLE cabinet_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), login text NOT NULL UNIQUE CHECK(login=lower(login) AND login ~ '^[a-z0-9_.-]{3,64}$'),
 display_name text NOT NULL, password_hash text, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cabinet_invites (
 token_hash text PRIMARY KEY, owner_id uuid NOT NULL REFERENCES cabinet_accounts(id), expires_at timestamptz NOT NULL, used_at timestamptz
);
CREATE TABLE cabinet_sessions (
 token_hash text PRIMARY KEY, owner_id uuid NOT NULL REFERENCES cabinet_accounts(id), csrf text NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cabinet_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES cabinet_accounts(id),
 label text NOT NULL, expected_username text NOT NULL, username text, telegram_user_id bigint,
 status text NOT NULL DEFAULT 'disconnected' CHECK(status IN ('disconnected','pending_qr','qr_ready','password_required','connected','expired','error')),
 generation integer NOT NULL DEFAULT 0, qr_svg text, qr_expires_at timestamptz, password_cipher text,
 error_code text, heartbeat_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,owner_id), UNIQUE(owner_id,expected_username)
);
CREATE TABLE cabinet_campaigns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES cabinet_accounts(id),
 connection_id uuid NOT NULL, name text NOT NULL, paused boolean NOT NULL DEFAULT true,
 daily_limit integer NOT NULL DEFAULT 10 CHECK(daily_limit BETWEEN 1 AND 100),
 window_start time NOT NULL DEFAULT '09:30', window_end time NOT NULL DEFAULT '11:30',
 revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,owner_id), UNIQUE(id,connection_id,owner_id), FOREIGN KEY(connection_id,owner_id) REFERENCES cabinet_connections(id,owner_id),
 CHECK(window_end>window_start), CHECK(extract(epoch FROM(window_end-window_start))>=daily_limit*180)
);
CREATE UNIQUE INDEX cabinet_connected_identity ON cabinet_connections(telegram_user_id) WHERE status='connected';
CREATE TABLE cabinet_api_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES cabinet_accounts(id),
 name text NOT NULL, token_hash text NOT NULL UNIQUE, display_prefix text NOT NULL,
 scopes text[] NOT NULL CHECK(scopes <@ ARRAY['outreach:read','outreach:draft','outreach:send','outreach:stop']::text[] AND cardinality(scopes)>0),
 campaign_ids uuid[] NOT NULL CHECK(cardinality(campaign_ids)>0),
 expires_at timestamptz NOT NULL, revoked_at timestamptz, last_used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cabinet_drafts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES cabinet_accounts(id), campaign_id uuid NOT NULL,
 address text NOT NULL, recipient_id bigint NOT NULL CHECK(recipient_id>0), name text NOT NULL DEFAULT '',
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 4000), source_url text NOT NULL DEFAULT '',
 permission_kind text CHECK(permission_kind IN ('request','consent')), permission_evidence text NOT NULL DEFAULT '',
 stopped boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,owner_id), UNIQUE(id,campaign_id,owner_id), UNIQUE(campaign_id,recipient_id), FOREIGN KEY(campaign_id,owner_id) REFERENCES cabinet_campaigns(id,owner_id)
);
CREATE TABLE cabinet_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES cabinet_accounts(id), draft_id uuid NOT NULL,
 campaign_id uuid NOT NULL, connection_id uuid NOT NULL, address text NOT NULL, recipient_id bigint NOT NULL,
 body text NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','failed','cancelled','uncertain')),
 random_id bigint NOT NULL UNIQUE CHECK(random_id>0), scheduled_at timestamptz NOT NULL,
 attempted_at timestamptz, completed_at timestamptz, telegram_message_id bigint, error_code text,
 UNIQUE(id,connection_id,recipient_id,owner_id),
 FOREIGN KEY(draft_id,campaign_id,owner_id) REFERENCES cabinet_drafts(id,campaign_id,owner_id),
 FOREIGN KEY(campaign_id,connection_id,owner_id) REFERENCES cabinet_campaigns(id,connection_id,owner_id),
 FOREIGN KEY(connection_id,owner_id) REFERENCES cabinet_connections(id,owner_id)
);
CREATE UNIQUE INDEX cabinet_active_recipient ON cabinet_jobs(connection_id,recipient_id) WHERE status IN ('queued','sending','uncertain');
CREATE INDEX cabinet_jobs_dispatch ON cabinet_jobs(connection_id,scheduled_at) WHERE status='queued';
CREATE TABLE cabinet_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES cabinet_accounts(id), job_id uuid NOT NULL,
 connection_id uuid NOT NULL, recipient_id bigint NOT NULL, telegram_message_id bigint NOT NULL,
 reply_to_message_id bigint, direction text NOT NULL CHECK(direction IN ('outbound','inbound')),
 body text NOT NULL, sent_at timestamptz NOT NULL, UNIQUE(connection_id,telegram_message_id),
 FOREIGN KEY(connection_id,owner_id) REFERENCES cabinet_connections(id,owner_id),
 FOREIGN KEY(job_id,connection_id,recipient_id,owner_id) REFERENCES cabinet_jobs(id,connection_id,recipient_id,owner_id)
);
CREATE TABLE cabinet_plans (
 token_hash text PRIMARY KEY, owner_id uuid NOT NULL REFERENCES cabinet_accounts(id), actor_key text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('launch','stop')), campaign_id uuid NOT NULL,
 draft_ids uuid[] NOT NULL, snapshot text NOT NULL, preview jsonb NOT NULL,
 expires_at timestamptz NOT NULL, consumed_at timestamptz,
 FOREIGN KEY(campaign_id,owner_id) REFERENCES cabinet_campaigns(id,owner_id)
);
CREATE TABLE cabinet_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner_id uuid NOT NULL REFERENCES cabinet_accounts(id),
 actor_key text NOT NULL, action text NOT NULL, target_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);

-- Serialize identity claims across the legacy and private workers. An unused
-- legacy placeholder (no user id) does not prevent QR login in a private cabinet.
CREATE FUNCTION guard_cabinet_telegram_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.telegram_user_id IS NULL THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('telegram-identity:' || NEW.telegram_user_id::text));
 IF TG_TABLE_NAME='cabinet_connections' THEN
  IF NEW.status='connected' AND EXISTS(SELECT 1 FROM outreach_telegram_profiles WHERE telegram_user_id=NEW.telegram_user_id) THEN
   RAISE EXCEPTION 'telegram_account_already_managed' USING ERRCODE='23514';
  END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM cabinet_connections WHERE telegram_user_id=NEW.telegram_user_id AND status='connected') THEN
   RAISE EXCEPTION 'telegram_account_already_managed' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cabinet_telegram_identity_guard BEFORE INSERT OR UPDATE OF telegram_user_id,status ON cabinet_connections
 FOR EACH ROW EXECUTE FUNCTION guard_cabinet_telegram_identity();
CREATE TRIGGER legacy_telegram_identity_guard BEFORE INSERT OR UPDATE OF telegram_user_id ON outreach_telegram_profiles
 FOR EACH ROW EXECUTE FUNCTION guard_cabinet_telegram_identity();
