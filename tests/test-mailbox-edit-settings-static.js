import fs from "node:fs";

const app = fs.readFileSync("public/app.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");
const worker = fs.readFileSync("src/worker/index.js", "utf8");

for (const field of [
  "daily_send_limit",
  "daily_warmup_limit",
  "min_delay_minutes",
  "max_delay_minutes",
  "send_window_start",
  "send_window_end",
  "send_days",
  "is_active",
  "warmup_enabled",
]) {
  if (!app.includes(`name="${field}"`) && !app.includes(`elements.${field}`)) {
    throw new Error(`mailbox edit form should expose ${field}`);
  }
}

if (!server.includes("daily_send_limit = CASE WHEN") || !server.includes("send_days = COALESCE")) {
  throw new Error("mailbox PATCH should update daily_send_limit and send_days");
}

if (!worker.includes("MIN(min_delay_minutes)") || worker.includes("interval '20 minutes'")) {
  throw new Error("warmup scheduler should use mailbox min_delay_minutes instead of hardcoded 20 minutes");
}

console.log("OK: mailbox edit settings static test passed");
