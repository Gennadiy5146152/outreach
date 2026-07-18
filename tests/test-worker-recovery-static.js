import fs from "node:fs";

const worker = fs.readFileSync("src/worker/index.js", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const env = fs.readFileSync("src/config/env.js", "utf8");
const envExample = fs.readFileSync(".env.example", "utf8");

for (const expected of [
  "async function recoverInterruptedQueues",
  "UPDATE sending_queue",
  "WHERE status = 'running'",
  "const staleJobFilter",
  "locked_at < now() - interval '15 minutes'",
  "const staleSendFilter",
  "updated_at < now() - interval '15 minutes'",
  "attempts < max_attempts THEN 'retrying'",
  "ELSE 'failed'",
  "scheduled_at = now()",
  "Восстановлено после перезапуска worker",
  "await recoverInterruptedQueues()",
  "await recoverInterruptedQueues({ staleOnly: true })",
  "queue_recovered",
  "recoveredSends",
  "failedSends",
]) {
  if (!worker.includes(expected)) {
    throw new Error(`worker recovery should include ${expected}`);
  }
}

for (const expected of [
  "Очередь восстановлена",
  "перезапуск worker",
  "зависшая задача в running",
  "отправок повторно",
  "отправок ошибок",
]) {
  if (!app.includes(expected)) {
    throw new Error(`worker recovery UI labels should include ${expected}`);
  }
}

for (const expected of [
  "inboxSyncIntervalMinutes: Number(process.env.INBOX_SYNC_INTERVAL_MINUTES || 1)",
]) {
  if (!env.includes(expected)) {
    throw new Error(`inbox sync should run every minute by default: ${expected}`);
  }
}

if (!envExample.includes("INBOX_SYNC_INTERVAL_MINUTES=1")) {
  throw new Error("env example should configure inbox sync every minute");
}

console.log("OK: worker recovery static test passed");
