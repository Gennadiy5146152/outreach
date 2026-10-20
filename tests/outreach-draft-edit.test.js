import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const start = source.indexOf('app.patch("/api/outreach/drafts/:id",');
const end = source.indexOf('\napp.put("/api/outreach/drafts/:id/steps/:position",', start);

function fixture({ stepStatus = "queued", queueStatus = "pending", draftStatus = "queued", missing = false, failQueue = false, deliveryBusy = false, rowBusy = false } = {}) {
  const calls = [];
  const draft = { id: "draft-1", status: draftStatus, to_email: "recipient@example.ru", mailbox_id: null, send_after: null };
  const step = { id: "step-1", draft_id: draft.id, position: 1, status: stepStatus };
  const queue = { id: "queue-1", status: queueStatus, outreach_step_id: step.id, sent_message_id: queueStatus === "sent" ? "message-1" : null };
  const client = { async query(sql, params = []) {
    sql = String(sql);
    calls.push({ sql, params });
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: !deliveryBusy }], rowCount: 1 };
    if (sql.includes("pg_advisory")) return { rows: [], rowCount: 0 };
    if (rowBusy && sql.includes("FOR UPDATE")) throw Object.assign(new Error("lock not available"), { code: "55P03" });
    if (/^\s*SELECT/.test(sql) && sql.includes("FROM sending_queue")) return { rows: [queue], rowCount: 1 };
    if (/^\s*SELECT/.test(sql) && sql.includes("FROM outreach_draft_steps")) return { rows: [step], rowCount: 1 };
    if (/^\s*SELECT/.test(sql) && sql.includes("FROM outreach_drafts")) return { rows: missing ? [] : [draft], rowCount: missing ? 0 : 1 };
    if (sql.includes("UPDATE outreach_drafts")) return { rows: missing ? [] : [{ ...draft, status: params[10] }], rowCount: missing ? 0 : 1 };
    if (sql.includes("INSERT INTO outreach_draft_steps")) return { rows: [step], rowCount: 1 };
    if (sql.includes("UPDATE sending_queue")) {
      if (failQueue) throw new Error("queue write failed");
      return { rows: [queue], rowCount: 1 };
    }
    throw new Error(`Unexpected database operation: ${sql}`);
  } };
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    app: { patch(route, fn) { handler = fn; } },
    asyncHandler: fn => fn,
    cleanText: value => String(value || "").trim(),
    normalizeOutboundBody: ({ bodyText, bodyHtml }) => ({ text: bodyText, html: bodyHtml }),
    parseOptionalDate: value => value || null,
    outreachDraftStatus: ({ body }) => body === "invalid" ? { status: "blocked", errors: ["invalid_copy"] } : { status: "ready", errors: [] },
    isUuid: () => true,
    lockOutreachQueueMutation: async c => c.query("SELECT pg_advisory_xact_lock_shared(hashtext($1))", ["outreach_delivery_control"]),
    OUTREACH_DELIVERY_LOCK: "outreach_delivery_control",
    withClient: fn => fn(client),
    query: client.query,
  });
  const req = { params: { id: draft.id }, body: { to_email: draft.to_email, company: "Company", subject: "ERP for the company", body_text: "New broad offer", body_html: "<p>New broad offer</p>", mailbox_id: null, send_after: null } };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  return { calls, req, res, run: () => handler(req, res) };
}

test("editing a queued first email synchronizes the pending queue copy atomically", async () => {
  const f = fixture();
  await f.run();
  const update = f.calls.find(c => c.sql.includes("UPDATE sending_queue"));
  assert.ok(update, "the existing queued copy must be updated, not just the draft card");
  assert.deepEqual(Array.from(update.params), ["draft-1", "step-1", "ERP for the company", "New broad offer", "<p>New broad offer</p>"]);
  assert.match(update.sql, /status IN \('pending','retrying'\)/);
  assert.doesNotMatch(update.sql.split("WHERE")[0], /requires_approval|approved_at|scheduled_at|mailbox_id|run_id|attempts|mode\s*=/);
  assert.equal(f.calls.at(-1).sql, "COMMIT");
  assert.equal(f.res.body.status, "queued");
});

for (const [label, opts, expected] of [
  ["sent step", { stepStatus: "sent" }, "sent_step_cannot_be_edited"],
  ["sent queue despite a stale step", { queueStatus: "sent" }, "sent_step_cannot_be_edited"],
  ["in-flight SMTP delivery", { queueStatus: "running" }, "draft_delivery_in_progress"],
]) test(`first-email editing rejects ${label} without rewriting history`, async () => {
  const f = fixture(opts);
  await assert.rejects(f.run(), error => error.status === 409 && error.message === expected);
  assert.equal(f.calls.some(c => /^\s*(UPDATE|INSERT)\b/.test(c.sql)), false);
  assert.equal(f.calls.at(-1).sql, "ROLLBACK");
});

test("copy edits preserve a paused draft and a step held for manual approval", async () => {
  const f = fixture({ draftStatus: "paused", stepStatus: "needs_approval" });
  await f.run();
  assert.equal(f.res.body.status, "paused");
  const step = f.calls.find(c => c.sql.includes("INSERT INTO outreach_draft_steps"));
  assert.equal(step.params[4], "needs_approval");
});

test("queue update failure rolls the draft and step changes back", async () => {
  const f = fixture({ failQueue: true });
  await assert.rejects(f.run(), /queue write failed/);
  assert.equal(f.calls.at(-1).sql, "ROLLBACK");
  assert.equal(f.calls.some(c => c.sql === "COMMIT"), false);
});

test("invalid copy cannot leave an active queue pointing at the previous body", async () => {
  const f = fixture();
  f.req.body.body_text = "invalid";
  await assert.rejects(f.run(), error => error.status === 400 && error.message === "queued_draft_invalid");
  assert.equal(f.calls.some(c => /^\s*(UPDATE|INSERT)\b/.test(c.sql)), false);
});

test("editing copy cannot silently reroute an already queued recipient", async () => {
  const f = fixture();
  f.req.body.to_email = "different@example.ru";
  await assert.rejects(f.run(), error => error.status === 409 && error.message === "queued_draft_routing_cannot_be_edited");
  assert.equal(f.calls.some(c => /^\s*(UPDATE|INSERT)\b/.test(c.sql)), false);
});

test("missing drafts return 404 without inserting a detached step", async () => {
  const f = fixture({ missing: true });
  await f.run();
  assert.equal(f.res.statusCode, 404);
  assert.equal(f.calls.some(c => /^\s*(UPDATE|INSERT)\b/.test(c.sql)), false);
});

test("copy editing rejects an SMTP critical section even when its row was cancelled", async () => {
  const f = fixture({ deliveryBusy: true, queueStatus: "cancelled", stepStatus: "cancelled", draftStatus: "cancelled" });
  await assert.rejects(f.run(), error => error.status === 409 && error.message === "draft_delivery_in_progress");
  assert.equal(f.calls.some(c => /^\s*(UPDATE|INSERT)\b/.test(c.sql)), false);
  assert.equal(f.calls.at(-1).sql, "ROLLBACK");
});

test("contended row locks return a retryable conflict and roll back without waiting", async () => {
  const f = fixture({ rowBusy: true });
  await assert.rejects(f.run(), error => error.status === 409 && error.message === "draft_edit_conflict_retry");
  assert.equal(f.calls.at(-1).sql, "ROLLBACK");
});
