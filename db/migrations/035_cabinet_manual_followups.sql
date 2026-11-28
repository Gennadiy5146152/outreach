ALTER TABLE cabinet_conversation_outcomes
 ADD COLUMN follow_up_on date,
 ADD COLUMN follow_up_note text NOT NULL DEFAULT '' CHECK(length(follow_up_note)<=1000),
 ADD COLUMN follow_up_updated_at timestamptz,
 ADD COLUMN follow_up_actor_key text;
CREATE INDEX cabinet_followups_due ON cabinet_conversation_outcomes(owner_id,campaign_id,follow_up_on,recipient_id) WHERE status='later';
