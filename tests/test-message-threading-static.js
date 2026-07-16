import fs from "node:fs";

const migration = fs.readFileSync("db/migrations/005_message_threading.sql", "utf8");
const worker = fs.readFileSync("src/worker/index.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");

for (const expected of [
  "threading_mode text NOT NULL DEFAULT 'new_thread'",
  "parent_message_id uuid REFERENCES messages(id)",
  "messages_parent_message_idx",
]) {
  if (!migration.includes(expected)) {
    throw new Error(`threading migration should include ${expected}`);
  }
}

for (const expected of [
  "let threadingMode = \"new_thread\"",
  "parentMessage",
  "Number(item.outreach_step_position || 1) > 1",
  "threadingMode = \"reply_to_previous\"",
  "parentMessage.message_id_header",
  "threading_mode, parent_message_id, in_reply_to, references_header",
  "inReplyTo: inReplyTo || undefined",
  "references: references || undefined",
  "isWarmup || !linked ? \"new_thread\" : \"reply_to_previous\"",
]) {
  if (!worker.includes(expected)) {
    throw new Error(`worker should preserve message threading: ${expected}`);
  }
}

for (const expected of [
  "threading_mode, parent_message_id",
  "previous?.message_id_header ? \"reply_to_previous\" : \"new_thread\"",
  "threading_mode: message.threading_mode",
  "parent_message_id: message.parent_message_id",
  "in_reply_to: message.in_reply_to",
]) {
  if (!server.includes(expected)) {
    throw new Error(`server should expose message threading: ${expected}`);
  }
}

for (const expected of [
  "new_thread: \"новая ветка\"",
  "reply_to_previous: \"ответом в ветку\"",
  "message.threading_mode ? pill(message.threading_mode)",
]) {
  if (!app.includes(expected)) {
    throw new Error(`frontend should explain message threading: ${expected}`);
  }
}

console.log("OK: message threading static test passed");
