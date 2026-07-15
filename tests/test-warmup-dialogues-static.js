import fs from "node:fs";

const migration = fs.readFileSync("db/migrations/002_warmup_dialogues.sql", "utf8");
const worker = fs.readFileSync("src/worker/index.js", "utf8");

if (!migration.includes("warmup_dialogues")) {
  throw new Error("warmup dialogues seed is missing");
}

if (!migration.includes("template_key") || !migration.includes("next_position")) {
  throw new Error("warmup thread state columns are missing");
}

const jsonMatch = migration.match(/\$json\$\s*([\s\S]*?)\s*\$json\$::jsonb/);
if (!jsonMatch) {
  throw new Error("warmup dialogues JSON seed is not found");
}

const seed = JSON.parse(jsonMatch[1]);
const messageCount = seed.dialogues.reduce((total, dialogue) => total + dialogue.messages.length, 0);

if (messageCount < 50 || messageCount > 100) {
  throw new Error(`expected 50-100 warmup messages, got ${messageCount}`);
}

if (!worker.includes("loadWarmupDialogues") || !worker.includes("warmup_threads")) {
  throw new Error("worker should load DB warmup dialogues and track threads");
}

if (!worker.includes("status = 'stale'") || !worker.includes("active_thread_continue")) {
  throw new Error("worker should expire stuck warmup threads and queue sync to continue active ones");
}

console.log(`OK: warmup dialogues static test passed (${messageCount} messages)`);
