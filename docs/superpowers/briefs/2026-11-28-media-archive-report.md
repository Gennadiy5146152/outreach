# Private media archive worker report — 2026-11-28

## Delivered files and boundaries

Changed only assigned implementation files: `deploy/telegram-connection/cabinet_media.py`, `cabinet_worker.py`, `Dockerfile`, `db/migrations/037_cabinet_media.sql`, and `tests/cabinet_media_test.py`, plus this requested report. Other agents own the response module, web/API/UI/MCP and deployment. No Telegram network calls, real sends, deployment, commits or subagents were used. Python/Telethon tests use the pinned `/tmp/outreach-replies-venv/bin/python` (Telethon 1.45.0).

## Schema and integration contract

`cabinet_media` has all agreed columns: UUID `id`, `owner_id`, `job_id`, `connection_id`, `recipient_id`, `telegram_message_id`, `kind`, `mime_type`, nullable positive BIGINT `size_bytes`, BIGINT `stored_bytes` default 0, nullable finite `duration_seconds`, `status`, nullable `storage_key`, nullable `sha256`, nullable `error_code`, `attempts` default 0, `next_attempt_at`, nullable paired `lease_token`/`lease_until`, `created_at`, `updated_at`.

One additional queue column is `connection_generation INTEGER NOT NULL`: copied from the currently checked connection when enqueuing/claiming and checked on lease refresh. Pending records may be claimed by a newly verified current generation of the same scoped connection; no old client generation can claim/finalize them. Ready records remain intact after disconnect.

Unique `(connection_id,telegram_message_id)` makes event/recovery/discovery queueing idempotent. A five-column FK binds media to the exact `(owner_id,job_id,connection_id,recipient_id,telegram_message_id)` message; a separate scoped job FK retains the original job/owner binding. Message FK cascades row cleanup for the existing test/data model; the worker never deletes ready files.

`cabinet_messages` adds `media_checked_at`, `media_check_error`, `media_check_attempts INTEGER DEFAULT 0`, and `media_check_next_attempt_at DEFAULT now()`. Migration marks only exact matching known sent service-text anchors checked, without modifying `sent_at` or timestamp provenance. Other historical messages start with unknown coverage. Discovery failure leaves `media_checked_at` NULL honestly; not-found/wrong-peer returned messages are checked with `media_message_unavailable` rather than successful media coverage. Discovery retries stop after 5 errors with `media_discovery_failed`.

`cabinet_media_rpc_state(connection_id PRIMARY KEY REFERENCES cabinet_connections ON DELETE CASCADE, blocked_until)` persists account RPC cooldown. Media FloodWait updates only this table and media queue state. `send_one` checks it before selecting/attempting a send and again after recipient proof; downloader and exact-ID discovery check it before RPCs. A media FloodWait never calls `CabinetWorker.pause`, cancels jobs or changes campaign revision. Original send-error handling is preserved.

Private API integration should expose only safe media metadata and authenticated URLs. `storage_key` is exactly `<ownerUUID>/<mediaUUID>.<safeext>`. Extensions: `ogg|mp3|m4a|wav|flac|webm|mp4|mov|bin`. MIME is an explicit audio/video whitelist or `application/octet-stream`; original Telegram filenames, file references, sessions and credentials are never persisted/exposed. Root owns authentication, scoped file lookup, regular-file `O_NOFOLLOW`, range serving and safe response headers.

## Helper and worker behavior

- `extract_media(message)` recognizes voice/audio/video/round video and safe MIME-based audio/video documents; no photos, text-only inference or external transcription.
- `enqueue_message(db, job, message)` performs SQL only. It runs inside the existing verified incoming-message transaction, including duplicates, and therefore metadata+queue roll back with message persistence. Existing `incoming` bool and recovery inserted-count semantics are retained. Empty imported bodies may receive exact returned captions; historical timestamps are untouched.
- `MediaArchive.run(row, client)` is a separate per-connection background task, cancelled before client disconnect. `run_once` acquires one global dedicated-session advisory lock `hashtext('cabinet-media-download')`. It claims one durable queue row with a UUID token and a two-minute renewable lease. Downloads hold no SQL transaction, delivery lock or reply lock.
- Every explicit media read, stream chunk and finalization rechecks active owner, connected current generation and exact imported message/job/peer binding. Only `PeerUser` for the known recipient and exact stored `get_messages(..., ids=...)` IDs are used. No usernames/contact search or arbitrary history is introduced.
- Exact-ID historical discovery reads at most 20 known IDs for one known recipient every 30 seconds per connection. Network errors back off from 30 seconds to at most one hour, with 5 attempts. A fresh live event/recovery can still provide metadata for a previously failed discovery.
- Downloads require known positive size. Default cap is 4 GiB (`CABINET_MEDIA_MAX_FILE_BYTES`), free floor 2 GiB (`CABINET_MEDIA_FREE_FLOOR_BYTES`). A global downloader avoids competing reservations. Free-space checks reserve the remaining declared size and repeat before and after each bounded network chunk. Existing filesystem bytes count in OS free space; an abandoned exact old leased partial is removed before new reservation. Cap, unknown-size and storage waits consume no network retry attempt.
- Each lease writes only `<mediaUUID>.<leaseUUID>.part` with exclusive/no-follow creation. Files are `0640`, root/owner directories `2750`; Docker worker runs UID 65532, primary GID 1000. Root must mount a durable private `CABINET_MEDIA_DIR` (default `/var/lib/cabinet-media`) and mount it read-only into web with shared GID 1000. Session directory remains worker-only.
- A complete file is fsynced, size-checked and SHA-256 hashed. Atomic rename, directory fsync and ready metadata commit occur under short current scope/lease locks. A disconnect/revocation before this section never publishes the final filename. A crash after rename but before DB commit is reconciled by checking the exact generated regular file, size and hash on a later claim. Only exact generated old/current partial files are removed; no glob-based cleanup or automatic ready-file deletion.
- `attempts` counts failed network/integrity attempts, not storage delays or FloodWait. Retry backoff starts at 30 seconds and is capped at one hour; 5 failed attempts become `failed`. Unknown unexpected stream errors become visible `failed/media_internal_error` rather than looping indefinitely.

Visible states are `queued`, `downloading`, `ready`, `waiting_storage`, `too_large`, `failed`, `unavailable`. Representative error codes include `media_size_unknown`, `media_storage_low`, `media_storage_unavailable`, `media_too_large`, `media_size_mismatch`, `media_document_changed`, `media_message_unavailable`, `media_network_error`, `media_internal_error`, `media_scope_changed`, `media_lease_lost`, and `telegram_rate_limit`.

Future successful service deliveries capture the exact Telegram result message date where present, with `timestamp_source='telegram'`; missing dates use current receipt time with `service_receipt`. Existing exact incoming event dates explicitly use `telegram`. Old anchors are not relabeled or rewritten. Known future text anchors are marked media checked at insertion.

## Verification and TDD evidence

Disposable database only: `postgres://postgres:cabinet_local_test_only@127.0.0.1:55493/cabinet_test_media`. Baseline migrations 1–35 were supplied. Applied 036/037 via `npm run migrate`; after the schema refinements, rebuilt only 037's new tables/columns in this assigned disposable DB and reapplied the final migration successfully. No other database was used.

Observed RED before the initial subsystem existed. Follow-up RED regressions reproduced unbounded discovery calls, final filename publication before final scope revocation checking, and an unexpected stream exception without a visible failed state. Corresponding implementations then passed.

Fresh final combined Python run: **76 tests passed = 23 new archive tests + all original 53 worker tests**, no skips. Existing worker fixture hard-codes two old DB names; its guard alone was extended in memory during loading to allow `/cabinet_test_media`. No repository changes were made to the original test file. The new media fixture accepts only localhost and `/cabinet_test(?:_[a-z0-9]+)?`, so CI's normal `cabinet_test` DB works unchanged.

Coverage includes typed extraction/filename distrust, exact verified queue scope, duplicate idempotency, transaction rollback, wrong-peer and wrong-recipient FK rejection, generation/owner revocation, atomic/hash/size/private-mode ready files, no SQL transaction/reply-lock held during streaming, disk floor before/during streaming, cap/unknown size, bounded retries, persisted FloodWait and queued-send deferral without campaign/job mutation, global downloader exclusion, expired/active leases, safe partial cleanup, restart after rename, symlink protection, exact-ID discovery/not-found coverage/backoff, future delivery timestamp provenance and unexpected stream failure.

Commands/results:

- `CABINET_TEST_DATABASE_URL=... /tmp/outreach-replies-venv/bin/python -m unittest discover -s tests -p cabinet_media_test.py`: 23/23 passed; the final combined in-memory loader ran 76/76 passed.
- `/tmp/outreach-replies-venv/bin/python -m py_compile deploy/telegram-connection/cabinet_media.py deploy/telegram-connection/cabinet_worker.py tests/cabinet_media_test.py`: passed.
- `npm run check`: exit 0, all applicable project checks passed. Three existing opt-in tests skipped (deferred-page UI, analytics navigation UI, sent snapshot DB test); no failing checks.

## Limits and review notes

No production storage, actual Telegram transfers, Docker build or deployed worker identity was exercised; root owns those checks. Restart recovery re-downloads interrupted partials under a fresh UUID lease rather than continuing unverified bytes. Unknown-size documents remain visibly deferred without making an unbounded read. Ready files are never reclaimed automatically; retention/deletion and manual requeue UX are outside this subsystem. Network/discovery failure never grants send authority or changes follow-up/semantic outcome controls.
