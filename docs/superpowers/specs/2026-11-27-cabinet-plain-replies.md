# Ordinary replies in cabinet outreach

The user approved fixing missing ordinary replies and recovering today's correspondence with the 14 recipients already contacted by Artem. The existing explicit-reply-only filter discards ordinary private responses.

Keep the existing owner, connection, generation and recipient boundaries. A private message without reply metadata belongs to the most recent successfully sent job to that exact recipient preceding its Telegram timestamp and message ID. An explicit reply must match a stored message in that recipient's chain; it must not fall back to another thread. Ignore unrelated peers, groups, service events, messages preceding outreach, and inactive/stale connections. Store text only, never download media or mark messages read. Capture manual outbound continuation too, excluding active deliveries to avoid racing the delivery receipt.

For recovery, a server-only maintenance command accepts exact connection and sent-job IDs and a bounded UTC time range no longer than one day. Resolve only these recipients, starting after each verified outgoing message; paginate with explicit limits and fail closed on identity mismatch, lock contention, incomplete history, or FloodWait. Acquire the existing per-connection worker lock before accessing its server-side session. Do not export sessions. Import idempotently through the same correlation logic; do not send messages, change schedules or mark dialogs read.

Approaches: broad inbox access would import unrelated history and is excluded. Scoped live matching plus an explicitly requested, bounded recovery reuses the existing message store and MCP thread endpoint without widening it to general history. No database migration is needed.

Validation: failing real-PostgreSQL regression tests first; test ordinary and explicit replies, continuation, timing, unrelated peers, owner/generation isolation, idempotence and bounded recovery using fake Telegram RPCs. Run repository/cabinet checks. Review before deployment; verify production code hashes and recover only the approved 14 jobs, then read their threads through MCP.
