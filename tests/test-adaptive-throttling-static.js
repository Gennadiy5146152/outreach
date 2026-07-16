import fs from "node:fs";

const worker = fs.readFileSync("src/worker/index.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const schema = fs.readFileSync("db/migrations/001_schema.sql", "utf8");

for (const expected of [
  "paused_until timestamptz",
  "error_count integer NOT NULL DEFAULT 0",
]) {
  if (!schema.includes(expected)) {
    throw new Error(`mailbox schema should support throttling: ${expected}`);
  }
}

for (const expected of [
  "function throttleDelayMinutes",
  "errorCount >= 5",
  "errorCount >= 3",
  "m.paused_until IS NULL OR m.paused_until <= now()",
  "m.is_active = true",
  "m.smtp_verified_at IS NOT NULL",
  "health_status = CASE WHEN error_count + 1 >= 3 THEN 'throttled' ELSE 'error' END",
  "paused_until = CASE",
  "interval '120 minutes'",
  "interval '30 minutes'",
  "Mailbox временно замедлен после",
  "pausedUntil",
  "adaptive_throttle",
  "nonMailboxError",
]) {
  if (!worker.includes(expected)) {
    throw new Error(`worker should adaptively throttle mailbox sending: ${expected}`);
  }
}

for (const expected of [
  "error_count = CASE WHEN $2 AND $3 THEN 0 ELSE error_count + 1 END",
  "paused_until = CASE WHEN $2 AND $3 THEN NULL ELSE paused_until END",
]) {
  if (!server.includes(expected)) {
    throw new Error(`mailbox check should reset throttle on success: ${expected}`);
  }
}

for (const expected of [
  "throttled: \"замедлен\"",
  "adaptive_throttle: \"автоматическое замедление из-за ошибок SMTP\"",
  "ошибок подряд",
  "замедлен до",
  "Ящик временно замедлен из-за ошибок отправки",
  "Ошибок отправки подряд",
]) {
  if (!app.includes(expected)) {
    throw new Error(`frontend should explain adaptive throttling: ${expected}`);
  }
}

console.log("OK: adaptive throttling static test passed");
