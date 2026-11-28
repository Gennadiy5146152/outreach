CREATE TABLE cabinet_conversation_outcomes (
 owner_id uuid NOT NULL REFERENCES cabinet_accounts(id) ON DELETE CASCADE,
 campaign_id uuid NOT NULL,
 recipient_id bigint NOT NULL CHECK(recipient_id>0),
 status text NOT NULL CHECK(status IN ('interested','later','declined','not_target','needs_review','booked')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 1000),
 evidence_message_ids bigint[] NOT NULL CHECK(cardinality(evidence_message_ids) BETWEEN 1 AND 20),
 snapshot text NOT NULL CHECK(snapshot ~ '^[a-f0-9]{32}$'),
 review_source text NOT NULL CHECK(review_source IN ('manual','agent')),
 reviewed_at timestamptz NOT NULL DEFAULT now(),
 actor_key text NOT NULL,
 PRIMARY KEY(owner_id,campaign_id,recipient_id),
 FOREIGN KEY(campaign_id,owner_id) REFERENCES cabinet_campaigns(id,owner_id) ON DELETE CASCADE
);
CREATE INDEX cabinet_stats_sent ON cabinet_jobs(owner_id,campaign_id,recipient_id,completed_at,id) WHERE status='sent';
CREATE INDEX cabinet_stats_messages ON cabinet_messages(owner_id,job_id,telegram_message_id);
