import fs from "node:fs";

const server = fs.readFileSync("src/server.js", "utf8");
const worker = fs.readFileSync("src/worker/index.js", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const packageJson = fs.readFileSync("package.json", "utf8");

for (const expected of [
  "app.post(\"/api/sending/:id/cancel\"",
  "status = 'cancelled'",
  "last_error = 'Отменено пользователем'",
  "stop_reason = 'queue_cancelled_by_user'",
  "status IN ('pending','retrying','running')",
  "sending_queue_cancelled",
  "cancelled_queue",
  "paused_enrollment",
  "cancelled_draft",
]) {
  if (!server.includes(expected)) {
    throw new Error(`queue cancel API should include ${expected}`);
  }
}

for (const expected of [
  "async function queueItemCancelled(queueId)",
  "if (await queueItemCancelled(item.id)) return",
  "UPDATE messages SET status = 'cancelled'",
  "const info = await sendMail(mailbox",
]) {
  if (!worker.includes(expected)) {
    throw new Error(`worker should guard cancelled sends before SMTP: ${expected}`);
  }
}

const cancelCheckIndex = worker.indexOf("if (await queueItemCancelled(item.id))");
const sendMailIndex = worker.indexOf("const info = await sendMail(mailbox");
if (cancelCheckIndex < 0 || sendMailIndex < 0 || cancelCheckIndex > sendMailIndex) {
  throw new Error("worker should check cancellation before SMTP sendMail");
}

for (const expected of [
  "function queueCanCancel",
  "function queueCancelButton",
  "data-cancel-send",
  "Отменить</button>",
  "api(`/api/sending/${cancelSendId}/cancel`",
  "Письмо снято с очереди",
]) {
  if (!app.includes(expected)) {
    throw new Error(`queue cancel UI should include ${expected}`);
  }
}

if (!packageJson.includes("node tests/test-queue-cancel-static.js")) {
  throw new Error("npm run check should include queue cancel regression test");
}

console.log("OK: queue cancel static test passed");
