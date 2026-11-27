# Private cabinet recipients without usernames

The user explicitly requested sending through Outreach to authors of public group messages who have no personal username. Implement this within the existing owner cabinet and human-approved prepare/execute flow. No new recipients are authorized for delivery merely by enabling the feature. Existing approved jobs remain unchanged.

## Approach and scope

Use Telegram's InputPeerUserFromMessage with the exact public group/message context. A numeric user ID alone lacks reliable peer context; inventing a username or exporting another account's access hash is not suitable. Manual UI sending does not satisfy the requested MCP workflow. The current Node/Postgres/Telethon architecture remains.

Creation has two mutually exclusive modes: existing address+recipient_id, or recipient_source+recipient_id with address omitted. recipient_source is a strict immutable object {chat_id: positive raw channel ID decimal string within signed bigint, username: normalized public group username, message_id: integer1..2147483647}. In source mode the server creates address tg://user?id=RECIPIENT_ID. The existing mutable source_url is research metadata, never identity authority.

Add nullable recipient_source JSONB to drafts/jobs. Existing null rows and username mode retain their behavior. Non-null JSON must have exactly the three correctly typed/bounded keys and match the canonical personal address. Do not introduce new ordinary-address DB constraints that invalidate existing null-source fixtures/data. Source metadata and personal identity cannot be edited. Copy metadata into both ordinary and one-off job inserts. Include it in full launch/queue-edit previews and queue reads; snapshots bind it. Queue edits reject job/draft source mismatches.

## Worker proof and delivery

For non-null source, validate exact metadata and canonical address again, failing closed without username fallback. Fresh contacts.ResolveUsernameRequest must yield the pinned PeerChannel and full public Channel megagroup with a matching active username, not broadcast/forbidden/min. Read only channels.GetMessagesRequest with one InputMessageID. Require one exact ordinary Message with matching message ID and PeerChannel, direct PeerUser.from_id equal to approved recipient_id, no forwarding/service/anonymous author, and a matching returned User that is not bot/deleted. Never identify a recipient through reply/forward/mention fields.

Construct InputPeerUserFromMessage(InputPeerChannel, message_id, recipient_id) only after proof. Never send to the group. No joins, contacts, participants, history/search reads, access-hash import/export or user-ID/username fallback. Telegram must permit the actual sending account to read the exact public source and contact that person; inaccessible sources fail clearly rather than being bypassed.

Recheck window/expiry and current delivery eligibility after proof awaits and before the durable attempt. Preserve account identity/generation, owner active, campaign pause, draft stop, queued status, quota/spacing, random_id, committed attempts, and uncertain no-retry. FloodWait/PeerFlood during either proof RPC pauses/cancels via the existing rate-limit policy before any attempt. Invalid/missing/mismatched proof fails only the job with telegram_source_invalid; inaccessible/network-timeout proof fails telegram_source_unavailable without attempted_at. After SendMessageRequest begins preserve existing delivery outcome handling. Syntax checks at prepare are not a claim that Telegram author proof already ran; proof is mandatory at dispatch, just as username identity is rechecked today.

## Verification and rollout

Use disposable Postgres and offline fake Telegram RPCs for tests, including strict JSON/immutability, both launch paths, source snapshot races, cross-mode UID dedup, successful exact proof, every proof mismatch, FloodWait, expiry/stop during proof and unchanged username behavior. Fresh independent security review and existing CI are required before rollout. No live test sends.

Before migration033 wait for the two currently approved messages to reach final states, verify no in-flight cabinet sends, stop cabinet-telegram before schema migration to prevent cached SELECTj.* failures, deploy the tested Node/migration commit, rebuild/recreate and hash-verify the worker, then confirm connection heartbeat. Do not create any production source-recipient jobs before the new worker is verified. Keep the permanent20/day and12:02–15:55 settings unchanged.

Official protocol references: https://core.telegram.org/api/min ; https://core.telegram.org/constructor/inputPeerUserFromMessage ; https://core.telegram.org/method/channels.getMessages .
