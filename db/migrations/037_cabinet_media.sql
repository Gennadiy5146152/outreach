-- Durable, tenant-scoped private audio/video archive. No session/file-reference secrets.
ALTER TABLE cabinet_messages ADD COLUMN media_checked_at timestamptz,
 ADD COLUMN media_check_error text,
 ADD COLUMN media_check_attempts integer NOT NULL DEFAULT 0 CHECK(media_check_attempts>=0),
 ADD COLUMN media_check_next_attempt_at timestamptz NOT NULL DEFAULT now(),
 ADD CONSTRAINT cabinet_messages_media_scope UNIQUE(owner_id,job_id,connection_id,recipient_id,telegram_message_id);
-- A verified service text anchor was sent by this worker, so its media absence is known.
UPDATE cabinet_messages m SET media_checked_at=now()
 FROM cabinet_jobs j WHERE j.id=m.job_id AND j.owner_id=m.owner_id
 AND j.connection_id=m.connection_id AND j.recipient_id=m.recipient_id
 AND j.status='sent' AND j.telegram_message_id=m.telegram_message_id AND m.direction='outbound' AND m.body=j.body;
CREATE TABLE cabinet_media (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
 job_id uuid NOT NULL, connection_id uuid NOT NULL, recipient_id bigint NOT NULL,
 telegram_message_id bigint NOT NULL, connection_generation integer NOT NULL,
 kind text NOT NULL CHECK(kind IN ('audio','voice','video','video_note')),
 mime_type text NOT NULL DEFAULT 'application/octet-stream',
 size_bytes bigint CHECK(size_bytes>0), stored_bytes bigint NOT NULL DEFAULT 0 CHECK(stored_bytes>=0),
 duration_seconds double precision CHECK(duration_seconds>=0 AND duration_seconds<'Infinity'),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','downloading','ready','waiting_storage','too_large','failed','unavailable')),
 storage_key text, sha256 text CHECK(sha256 ~ '^[a-f0-9]{64}$'), error_code text,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid, lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(connection_id,telegram_message_id),
 FOREIGN KEY(owner_id,job_id,connection_id,recipient_id,telegram_message_id)
 REFERENCES cabinet_messages(owner_id,job_id,connection_id,recipient_id,telegram_message_id) ON DELETE CASCADE,
 FOREIGN KEY(job_id,connection_id,recipient_id,owner_id) REFERENCES cabinet_jobs(id,connection_id,recipient_id,owner_id),
 CHECK(storage_key IS NULL OR storage_key ~ ('^' || owner_id::text || '/' || id::text || '\.(ogg|mp3|m4a|wav|flac|webm|mp4|mov|bin)$')),
 CHECK(status<>'ready' OR (storage_key IS NOT NULL AND sha256 IS NOT NULL AND size_bytes IS NOT NULL AND size_bytes=stored_bytes AND lease_token IS NULL AND lease_until IS NULL)),
 CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE INDEX cabinet_media_pending ON cabinet_media(connection_id,next_attempt_at,created_at)
 WHERE status IN ('queued','waiting_storage','downloading');
CREATE INDEX cabinet_media_owner_job ON cabinet_media(owner_id,job_id,telegram_message_id);
CREATE INDEX cabinet_messages_media_discovery ON cabinet_messages(connection_id,recipient_id,telegram_message_id)
 WHERE media_checked_at IS NULL;
CREATE TABLE cabinet_media_rpc_state (
 connection_id uuid PRIMARY KEY REFERENCES cabinet_connections(id) ON DELETE CASCADE,
 blocked_until timestamptz NOT NULL
);
