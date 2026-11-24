-- Existing tokens retain their explicit allowlists. Only newly opted-in tokens
-- can cover every current and future campaign belonging to their owner.
ALTER TABLE cabinet_api_tokens ADD COLUMN all_campaigns boolean NOT NULL DEFAULT false;
ALTER TABLE cabinet_api_tokens DROP CONSTRAINT cabinet_api_tokens_campaign_ids_check;
ALTER TABLE cabinet_api_tokens ADD CONSTRAINT cabinet_api_tokens_campaign_ids_check
 CHECK((all_campaigns AND cardinality(campaign_ids)=0) OR
       (NOT all_campaigns AND (cardinality(campaign_ids)>0 OR scopes=ARRAY['instagram:read']::text[])));
