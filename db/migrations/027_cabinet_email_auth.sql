ALTER TABLE cabinet_accounts ADD COLUMN email text;
ALTER TABLE cabinet_accounts ADD COLUMN email_verified_at timestamptz;
ALTER TABLE cabinet_accounts ADD COLUMN auth_revision integer NOT NULL DEFAULT 0;
ALTER TABLE cabinet_accounts ADD CONSTRAINT cabinet_email_format CHECK(email IS NULL OR (email=lower(btrim(email)) AND length(email)<=254 AND email LIKE '%@%'));
CREATE UNIQUE INDEX cabinet_account_email_unique ON cabinet_accounts(email) WHERE email IS NOT NULL;

CREATE TABLE cabinet_admin_recovery (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 password_hash text, auth_revision integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO cabinet_admin_recovery(singleton) VALUES(true);

CREATE TABLE cabinet_email_challenges (
 token_hash text PRIMARY KEY,
 kind text NOT NULL CHECK(kind IN ('register','reset','attach','admin_reset')),
 owner_id uuid REFERENCES cabinet_accounts(id),
 email text NOT NULL, display_name text NOT NULL DEFAULT '', auth_revision integer NOT NULL DEFAULT 0,
 expires_at timestamptz NOT NULL, used_at timestamptz, sent_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cabinet_email_challenge_account ON cabinet_email_challenges(owner_id);
