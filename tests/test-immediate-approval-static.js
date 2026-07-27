import fs from "node:fs";

const server = fs.readFileSync("src/server.js", "utf8");
const worker = fs.readFileSync("src/worker/index.js", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const index = fs.readFileSync("public/index.html", "utf8");
const packageJson = fs.readFileSync("package.json", "utf8");

for (const expected of [
  "scheduled_at = CASE WHEN scheduled_at <= now() THEN now() ELSE scheduled_at END",
  "WHERE campaign_id = $1 AND status = 'pending'",
  "AND (requires_approval = false OR approved_at IS NOT NULL)",
  "GREATEST(0, COALESCE(m.min_delay_minutes, c.min_delay_minutes, 7))",
  "WITH deliverable AS",
  "optionalNonNegativeInteger(req.body.min_delay_minutes",
  "optionalNonNegativeInteger(req.body.max_delay_minutes",
]) {
  if (!server.includes(expected)) {
    throw new Error(`immediate approval backend should include ${expected}`);
  }
}

if (server.includes("interval '7 minutes'")) {
  throw new Error("campaign launch should not force a seven-minute gap when mailbox delay is zero");
}

for (const expected of [
  "const floor = Number(min ?? 7)",
  "const ceil = Math.max(Number(max ?? 18), floor)",
  "COALESCE(m.min_delay_minutes, c.min_delay_minutes) AS min_delay_minutes",
  "COALESCE(m.max_delay_minutes, c.max_delay_minutes) AS max_delay_minutes",
]) {
  if (!worker.includes(expected)) {
    throw new Error(`worker should preserve zero delay: ${expected}`);
  }
}

for (const expected of [
  "const nextCountdown = next && new Date(next.scheduled_at).getTime() <= Date.now() ? \"сейчас\"",
  "Следующее письмо: ${nextCountdown}",
]) {
  if (!app.includes(expected)) {
    throw new Error(`queue UI should avoid confusing overdue text: ${expected}`);
  }
}

for (const expected of [
  "name=\"min_delay_minutes\" type=\"number\" min=\"0\"",
  "name=\"max_delay_minutes\" type=\"number\" min=\"0\"",
]) {
  if (!index.includes(expected) || !app.includes(expected)) {
    throw new Error(`mailbox delay controls should allow zero: ${expected}`);
  }
}

if (!packageJson.includes("node tests/test-immediate-approval-static.js")) {
  throw new Error("npm run check should include immediate approval regression test");
}

console.log("OK: immediate approval static test passed");
