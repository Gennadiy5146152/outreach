CREATE TABLE cabinet_instagram_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES cabinet_accounts(id),
 instagram_user_id text NOT NULL UNIQUE,
 username text NOT NULL, name text NOT NULL DEFAULT '', account_type text NOT NULL,
 token_cipher text NOT NULL, token_expires_at timestamptz NOT NULL,
 connected_at timestamptz NOT NULL DEFAULT now(), checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cabinet_instagram_owner ON cabinet_instagram_connections(owner_id);
CREATE TABLE cabinet_instagram_oauth (
 state_hash text PRIMARY KEY, nonce_hash text NOT NULL,
 owner_id uuid NOT NULL REFERENCES cabinet_accounts(id), session_hash text NOT NULL,
 expires_at timestamptz NOT NULL
);
ALTER TABLE cabinet_api_tokens DROP CONSTRAINT cabinet_api_tokens_scopes_check;
ALTER TABLE cabinet_api_tokens DROP CONSTRAINT cabinet_api_tokens_campaign_ids_check;
ALTER TABLE cabinet_api_tokens ADD CONSTRAINT cabinet_api_tokens_scopes_check
 CHECK(scopes <@ ARRAY['outreach:read','outreach:draft','outreach:send','outreach:stop','instagram:read']::text[] AND cardinality(scopes)>0);
ALTER TABLE cabinet_api_tokens ADD CONSTRAINT cabinet_api_tokens_campaign_ids_check
 CHECK(cardinality(campaign_ids)>0 OR scopes=ARRAY['instagram:read']::text[]);
