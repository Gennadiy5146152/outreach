import fs from "node:fs";

const worker = fs.readFileSync("src/worker/index.js", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");

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

console.log("OK: worker recovery static test passed");
