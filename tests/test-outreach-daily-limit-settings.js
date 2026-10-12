import assert from "node:assert/strict";
import fs from "node:fs";
import { normalizeOutreachDailyLimit } from "../src/services/runtime.js";

assert.equal(normalizeOutreachDailyLimit(undefined), 100, "missing limit should default to 100");
assert.equal(normalizeOutreachDailyLimit("250"), 250, "numeric form values should normalize");
assert.equal(normalizeOutreachDailyLimit(0), 100, "zero should fall back to the safe default");
assert.equal(normalizeOutreachDailyLimit(10001), 100, "values above the supported maximum should fall back");

const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const handlers = fs.readFileSync(new URL("../src/mcp/tool-handlers.js", import.meta.url), "utf8");

for (const required of [
  "outreachDailyLimit: runtime.outreachDailyLimit",
  "outreach_daily_limit_must_be_between_1_and_10000",
  "outreachDailyLimit,",
]) {
  assert.ok(server.includes(required), `server runtime API should include ${required}`);
}

assert.ok(app.includes('name="outreachDailyLimit"'), "settings UI should expose the aggregate outreach limit");
assert.ok(app.includes("payload.outreachDailyLimit = Number(payload.outreachDailyLimit)"), "settings form should submit a numeric limit");
assert.ok(handlers.includes("outreachDailyLimit: runtime.outreachDailyLimit || 100"), "MCP delivery-mode update should preserve the limit");

console.log("OK: aggregate outreach daily limit settings are wired through runtime, API, UI, and MCP");
