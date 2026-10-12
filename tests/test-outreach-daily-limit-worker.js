import assert from "node:assert/strict";
import fs from "node:fs";

const worker = fs.readFileSync(new URL("../src/worker/index.js", import.meta.url), "utf8");

for (const required of [
  'import { quotaRemaining } from "../services/outreach-quota.js"',
  "pg_advisory_xact_lock(hashtext('outreach_daily_quota'))",
  "runtime.outreachDailyLimit",
  "msg.type = 'outreach'",
  "msg.direction = 'outbound'",
  "msg.status = 'sent'",
  "AT TIME ZONE $1",
  "reserved_queue.status = 'running'",
  "reserved_queue.mode <> 'test'",
  "m.daily_send_limit",
  "c.daily_limit",
  "quotaRemaining({",
  "COALESCE(ods.position, s.position, 1) > 1 THEN 0",
]) {
  assert.ok(worker.includes(required), `worker aggregate quota should include ${required}`);
}

const priorityIndex = worker.indexOf("COALESCE(ods.position, s.position, 1) > 1 THEN 0");
const scheduledIndex = worker.indexOf("q.scheduled_at ASC", priorityIndex);
assert.ok(priorityIndex >= 0 && scheduledIndex > priorityIndex, "follow-up priority must be evaluated before scheduled time");

console.log("OK: worker enforces aggregate outreach quota and prioritizes follow-ups");
