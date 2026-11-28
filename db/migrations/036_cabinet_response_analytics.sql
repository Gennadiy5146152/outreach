CREATE TABLE cabinet_response_schedules (
 owner_id uuid NOT NULL REFERENCES cabinet_accounts(id) ON DELETE CASCADE,
 campaign_id uuid NOT NULL,
 timezone text NOT NULL DEFAULT 'Europe/Moscow' CHECK(timezone='Europe/Moscow'),
 weekdays integer[] NOT NULL CHECK(CASE WHEN array_ndims(weekdays)=1 AND array_lower(weekdays,1)=1
  THEN cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[1,2,3,4,5,6,7] AND array_position(weekdays,NULL) IS NULL
  ELSE false END),
 start_time time NOT NULL,
 end_time time NOT NULL CHECK(end_time>start_time),
 revision integer NOT NULL CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,campaign_id),
 FOREIGN KEY(campaign_id,owner_id) REFERENCES cabinet_campaigns(id,owner_id) ON DELETE CASCADE,
 -- Saved weekdays are canonical and sorted; adjacent checks reject duplicates.
 CHECK(weekdays[1]<COALESCE(weekdays[2],8)
  AND COALESCE(weekdays[2],0)<COALESCE(weekdays[3],8)
  AND COALESCE(weekdays[3],0)<COALESCE(weekdays[4],8)
  AND COALESCE(weekdays[4],0)<COALESCE(weekdays[5],8)
  AND COALESCE(weekdays[5],0)<COALESCE(weekdays[6],8)
  AND COALESCE(weekdays[6],0)<COALESCE(weekdays[7],8))
);

ALTER TABLE cabinet_messages
 ADD COLUMN timestamp_source text NOT NULL DEFAULT 'telegram'
 CHECK(timestamp_source IN ('telegram','service_receipt'));

-- Existing service anchors contain receipt time; preserve that time and label it.
UPDATE cabinet_messages m SET timestamp_source='service_receipt'
FROM cabinet_jobs j
WHERE j.id=m.job_id AND j.owner_id=m.owner_id AND j.connection_id=m.connection_id
 AND j.recipient_id=m.recipient_id AND j.telegram_message_id=m.telegram_message_id
 AND m.direction='outbound';
