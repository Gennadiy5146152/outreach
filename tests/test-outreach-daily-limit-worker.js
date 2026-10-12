import assert from "node:assert/strict";
import fs from "node:fs";

const worker = fs.readFileSync(new URL("../src/worker/index.js", import.meta.url), "utf8");
const mail = fs.readFileSync(new URL("../src/services/mail.js", import.meta.url), "utf8");
const migration = fs.readFileSync(new URL("../db/migrations/014_outreach_quota_reservations.sql", import.meta.url), "utf8");

for (const required of [
  'import { effectiveOutreachDryRun } from "../services/outreach-quota.js"',
  "pg_advisory_xact_lock(hashtext('outreach_daily_quota'))",
  "runtime.outreachDailyLimit",
  "msg.type = 'outreach'",
  "msg.direction = 'outbound'",
  "msg.status = 'sent'",
  "AT TIME ZONE $1",
  "::timestamp AT TIME ZONE $1",
  "reserved_queue.quota_reservation_active = true",
  "reserved_queue.mode <> 'test'",
  "COALESCE(mailbox_msg.provider_message_id, '') <> 'dry-run'",
  "COALESCE(m.daily_send_limit, $3::int)",
  "c.daily_limit",
  "shouldReserveOutreachQuota({ dryRun: runtime.dryRun, mode: item.mode })",
  "q.mode = 'test' OR $2::boolean",
  "status <> 'running'",
  "orphanedReservations",
  "COALESCE(ods.position, s.position, 1) > 1 THEN 0",
  "OUTREACH_MIN_SPACING_MINUTES",
  "spacing_msg.mailbox_id = q.mailbox_id",
  "spacing_msg.type = 'outreach'",
  "spacing_msg.status = 'sent'",
  "spacing_msg.sent_at > now() - make_interval",
  "spacing_queue.mailbox_id = q.mailbox_id",
  "spacing_queue.quota_reservation_active = true",
  "spacing_queue.mode <> 'test'",
  "q.mode = 'test'",
  "withOutreachDeliveryLock",
  "lockOutreachQueueMutation",
  "previous_queue.mode <> 'test'",
  "real_chain.mode <> 'test'",
  "c.test_mode = false",
  "queueItemStatus",
  '["sent", "cancelled"]',
  "item.delivery_dry_run",
  "deliveryDryRun",
  "dryRun: deliveryDryRun",
  "AND status = 'running'",
  "item.mode === \"test\" && nextStep",
]) {
  assert.ok(worker.includes(required), `worker per-mailbox quota should include ${required}`);
}

assert.ok(!worker.includes("globalQuotaAvailable"), "worker must not share one quota across all mailboxes");

for (const required of ["options.dryRun", "Boolean(options.dryRun)"]) {
  assert.ok(mail.includes(required), `mail delivery should support a pinned dry-run decision: ${required}`);
}

const priorityIndex = worker.indexOf("COALESCE(ods.position, s.position, 1) > 1 THEN 0");
const scheduledIndex = worker.indexOf("q.scheduled_at ASC", priorityIndex);
assert.ok(priorityIndex >= 0 && scheduledIndex > priorityIndex, "follow-up priority must be evaluated before scheduled time");
assert.match(worker, /console\.log\("Outreach worker started"\);\s*await recoverInterruptedQueues\(\{ staleOnly: true \}\);/, "startup recovery must not steal a live worker reservation");
assert.ok(migration.includes("quota_reservation_active boolean NOT NULL DEFAULT false"), "migration should persist reservation ownership across queue status changes");
assert.ok(migration.includes("quota_reserved_at timestamptz"), "migration should timestamp quota leases for stale recovery");

console.log("OK: worker enforces a separate outreach quota per mailbox and prioritizes follow-ups");
