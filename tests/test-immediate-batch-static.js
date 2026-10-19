import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const worker = fs.readFileSync(new URL("../src/worker/index.js", import.meta.url), "utf8");

assert.ok(
  server.includes('normalizeDraftLaunchMode(req.body.mode)'),
  "draft launch API must preserve the immediate mode instead of coercing it to auto",
);
assert.ok(
  server.includes("AS has_followups") && server.includes("immediate_followups_not_allowed"),
  "draft launch API must reject immediate sequences that contain follow-ups",
);
assert.ok(
  server.includes('["manual", "auto", "test"].includes(requestedMode)')
    && server.includes('invalid_campaign_launch_mode'),
  "campaign launch API must reject immediate and unknown modes",
);
assert.ok(
  server.includes('const scheduledAt = mode === "immediate" ? new Date()'),
  "immediate draft launch must ignore future send_after dates and queue for now",
);
assert.ok(
  worker.includes("q.mode = 'immediate'")
    && worker.includes("q.outreach_draft_id IS NOT NULL")
    && worker.includes("q.campaign_id IS NULL")
    && worker.includes("ods.position = 1"),
  "only first-step personal drafts may receive the immediate queue bypass",
);
assert.ok(
  worker.includes('!isImmediateDraftQueueItem(item) && !isWithinWindow(item, runtime.timeZone)'),
  "immediate queue items must bypass the normal send window",
);
assert.ok(
  worker.includes('item.mode !== "immediate" && nextOutreachStep'),
  "an immediate item must never create a follow-up queue item",
);
assert.ok(
  worker.includes("WHEN q.mode = 'immediate'") && worker.includes("ods.position = 1 THEN -1"),
  "due immediate draft items must be selected ahead of ordinary queue items",
);
assert.ok(
  worker.includes('const to = item.mode === "test" ? item.mailbox_email : item.lead_email'),
  "immediate delivery must still use the real lead recipient",
);
assert.ok(
  worker.includes('item.mode === "test" ? "test" : "outreach"'),
  "immediate delivery must remain a real outreach message",
);

console.log("OK: immediate batch bypass is scoped to spacing and send windows");
