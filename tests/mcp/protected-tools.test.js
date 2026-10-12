import assert from "node:assert/strict";
import test from "node:test";
import { createConfirmationStore } from "../../src/mcp/confirmation-store.js";
import { createToolHandlers } from "../../src/mcp/tool-handlers.js";
import { TOOL_DEFINITIONS } from "../../src/mcp/tool-definitions.js";

function createProtectedFixture() {
  const calls = [];
  const state = {
    dryRun: false,
    draftPreflight: {
      ok: true,
      errors: [],
      warnings: [],
      items: [{ id: "draft-1", email: "lead@example.com", status: "ready", subject: "Hello", mailbox: "sales@example.com", followup_count: 2 }],
      stats: { selected: 1, found: 1, ready: 1, blocked: 0 },
    },
    campaignPreflight: { ok: true, errors: [], warnings: [], stats: { enrollments: 1, valid: 1 } },
    campaignReview: { campaign: { id: "campaign-1", name: "October", updated_at: "2026-10-11T10:00:00Z", steps: [{ id: "campaign-step-1", subject_template: "Hello", body_template_text: "Campaign body", attachments: [{ id: "attachment-1", file_name: "offer.pdf" }] }] }, enrollments: [{ enrollment_id: "enrollment-1", enrollment_status: "active", lead_id: "lead-1", email: "lead@example.com", mailbox_id: "mailbox-1", current_step: 1 }, { enrollment_id: "enrollment-2", enrollment_status: "paused", lead_id: "lead-2", email: "lead2@example.com", mailbox_id: "mailbox-1", current_step: 1 }], active_enrollments: [{ enrollment_id: "enrollment-1", enrollment_status: "active", lead_id: "lead-1", email: "lead@example.com", mailbox_id: "mailbox-1", current_step: 1 }] },
    drafts: [{ id: "draft-1", status: "ready", subject: "Hello", body_text: "Complete body", body_html: "<p>Complete body</p>", updated_at: "2026-10-11T10:00:00Z", steps: [{ id: "outreach-step-1", position: 1, subject: "Hello", body_text: "Complete body", attachments: [] }, { id: "outreach-step-2", position: 2, subject: "Follow-up", body_text: "Full follow-up", delay_days: 3, attachments: [] }] }],
    queue: [{ id: "queue-1", status: "pending", requires_approval: true, approved_at: null, updated_at: "2026-10-11T10:00:00Z", email: "lead@example.com" }],
    conversation: { conversation: { id: "conversation-1", status: "needs_review", updated_at: "2026-10-11T10:00:00Z", email: "lead@example.com", last_message_at: "2026-10-11T09:00:00Z" }, messages: [] },
    suppressions: [],
    run: { id: "run-1", status: "active", updated_at: "2026-10-11T10:00:00Z", total_recipients: 4 },
    stopAllImpact: { active_queue: 5, first_touches: 3, followups: 2, active_runs: 2, active_enrollments: 4, active_drafts: 5 },
    settings: { runtime: { dryRun: false, publicTrackingUrl: "https://track.example.com", maxAttachmentMb: 50, outreachStopScope: "company", timeZone: "Europe/Moscow", inboxSyncIntervalSeconds: 60 } },
    mailboxes: [{ id: "mailbox-1", email: "sales@example.com", is_active: true, smtp_verified_at: "2026-10-11T08:00:00Z" }],
    failNextMutation: false,
  };

  function responseForGet(endpoint) {
    if (endpoint === "/api/health") return { ok: true, dryRun: state.dryRun };
    if (endpoint === "/api/settings") return structuredClone(state.settings);
    if (endpoint === "/api/mailboxes") return structuredClone(state.mailboxes);
    if (endpoint === "/api/leads/lead-1/detail") return { lead: { id: "lead-1", email: "lead@example.com", company: "Example" } };
    if (endpoint === "/api/campaigns") return [structuredClone(state.campaignReview.campaign)];
    if (endpoint === "/api/campaigns/campaign-1/preflight") return structuredClone(state.campaignPreflight);
    if (endpoint === "/api/campaigns/campaign-1/review") return structuredClone(state.campaignReview);
    if (endpoint === "/api/outreach/drafts") return { rows: structuredClone(state.drafts), pagination: { page: 1, pageSize: 100, total: state.drafts.length, totalPages: 1 } };
    if (endpoint === "/api/outreach/drafts/draft-1/review") return structuredClone(state.drafts[0]);
    if (endpoint === "/api/sending/queue-1/review") return structuredClone(state.queue[0]);
    if (endpoint === "/api/outreach/conversations/conversation-1") return structuredClone(state.conversation);
    if (endpoint === "/api/outreach/conversations/conversation-1/classification-impact") return { classification: "unsubscribe", stop_scope: "same_company", affected_count: 1, leads: [{ id: "lead-1", email: "lead@example.com" }], conversation: structuredClone(state.conversation.conversation) };
    if (endpoint === "/api/suppressions") return structuredClone(state.suppressions);
    if (endpoint === "/api/suppressions/impact") return { scope: "email", target: "lead@example.com", affected_count: 1, leads: [{ id: "lead-1", email: "lead@example.com" }] };
    if (endpoint === "/api/outreach/runs/run-1") return structuredClone(state.run);
    if (endpoint === "/api/outreach/stop-all/impact") return structuredClone(state.stopAllImpact);
    throw new Error(`unexpected GET ${endpoint}`);
  }

  const client = {
    async get(endpoint, options) {
      calls.push({ method: "get", endpoint, body: options });
      return responseForGet(endpoint);
    },
    async post(endpoint, body) {
      calls.push({ method: "post", endpoint, body });
      if (endpoint === "/api/outreach/drafts/preflight") return structuredClone(state.draftPreflight);
      if (state.failNextMutation) {
        state.failNextMutation = false;
        throw new Error("downstream mutation failed");
      }
      return { ok: true, endpoint, body };
    },
    async put(endpoint, body) {
      calls.push({ method: "put", endpoint, body });
      if (state.failNextMutation) {
        state.failNextMutation = false;
        throw new Error("downstream mutation failed");
      }
      return { ok: true, endpoint, body };
    },
    async patch(endpoint, body) {
      calls.push({ method: "patch", endpoint, body });
      if (state.failNextMutation) {
        state.failNextMutation = false;
        throw new Error("downstream mutation failed");
      }
      return { ok: true, endpoint, body };
    },
    async delete(endpoint, body) {
      calls.push({ method: "delete", endpoint, body });
      return { ok: true, endpoint, body };
    },
  };
  let tokenIndex = 0;
  const confirmations = createConfirmationStore({ now: () => 1_000, randomUUID: () => `confirmation-${++tokenIndex}` });
  return { handlers: createToolHandlers({ client, confirmations }), calls, state };
}

function tokenOf(result) {
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.equal(result.structuredContent.data.requires_confirmation, true);
  assert.match(result.structuredContent.data.confirmation_token, /^confirmation-/);
  return result.structuredContent.data.confirmation_token;
}

test("queue approval schema cannot request more rows than the authoritative snapshot fetches", () => {
  const definition = TOOL_DEFINITIONS.find((item) => item.name === "queue_approval_prepare");
  const result = definition.inputSchema.safeParse({ queue_ids: Array.from({ length: 101 }, (_, index) => `queue-${index}`) });
  assert.equal(result.success, false);
});

test("draft launch requires prepare and exact unchanged preflight before mutation", async () => {
  const { handlers, calls, state } = createProtectedFixture();
  const prepared = await handlers.launch_prepare({ source: "drafts", draft_ids: ["draft-1"], mode: "auto", daily_first_limit: 25 });
  const token = tokenOf(prepared);
  assert.equal(calls.some((call) => call.endpoint === "/api/outreach/drafts/start"), false);

  state.drafts[0].steps[1].body_text = "Changed after approval";
  const blocked = await handlers.launch_execute({ confirmation_token: token, confirm: true });
  assert.equal(blocked.isError, true);
  assert.equal(blocked.structuredContent.data.code, "confirmation_state_changed");
  assert.equal(calls.some((call) => call.endpoint === "/api/outreach/drafts/start"), false);

  state.drafts[0].steps[1].body_text = "Full follow-up";
  const preparedAgain = await handlers.launch_prepare({ source: "drafts", draft_ids: ["draft-1"], mode: "auto", daily_first_limit: 25 });
  const executed = await handlers.launch_execute({ confirmation_token: tokenOf(preparedAgain), confirm: true });
  assert.equal(executed.isError, undefined);
  assert.deepEqual(calls.at(-1), {
    method: "post",
    endpoint: "/api/outreach/drafts/start",
    body: { draft_ids: ["draft-1"], mode: "auto", daily_first_limit: 25 },
  });
});

test("failed preflight never creates an executable launch plan", async () => {
  const { handlers, calls, state } = createProtectedFixture();
  state.draftPreflight = { ...state.draftPreflight, ok: false, errors: ["Mailbox is not ready"] };
  const result = await handlers.launch_prepare({ source: "drafts", draft_ids: ["draft-1"], mode: "auto" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.data.code, "preflight_failed");
  assert.equal(calls.some((call) => call.endpoint === "/api/outreach/drafts/start"), false);
});

test("campaign launch binds campaign state, preflight, dry-run, and mode", async () => {
  const { handlers, calls, state } = createProtectedFixture();
  const prepared = await handlers.launch_prepare({ source: "campaign", campaign_id: "campaign-1", mode: "manual" });
  assert.equal(prepared.structuredContent.data.preview.current_state.campaign.steps[0].body_template_text, "Campaign body");
  state.campaignReview.active_enrollments[0].lead_id = "lead-2";
  const blocked = await handlers.launch_execute({ confirmation_token: tokenOf(prepared), confirm: true });
  assert.equal(blocked.structuredContent.data.code, "confirmation_state_changed");
  state.campaignReview.active_enrollments[0].lead_id = "lead-1";
  const preparedAgain = await handlers.launch_prepare({ source: "campaign", campaign_id: "campaign-1", mode: "manual" });
  const executed = await handlers.launch_execute({ confirmation_token: tokenOf(preparedAgain), confirm: true });
  assert.equal(executed.isError, undefined);
  assert.deepEqual(calls.at(-1), {
    method: "post",
    endpoint: "/api/campaigns/campaign-1/start",
    body: { mode: "manual" },
  });
});

test("protected workflows prepare authoritative state and execute only with confirmation", async () => {
  const cases = [
    {
      prepare: "queue_approval_prepare", prepareInput: { queue_ids: ["queue-1"] },
      execute: "queue_approval_execute", mutation: { method: "post", endpoint: "/api/sending/queue-1/approve", body: {} },
    },
    {
      prepare: "reply_prepare", prepareInput: { conversation_id: "conversation-1", mailbox_id: "mailbox-1", subject: "Re: Hello", body_text: "Thanks" },
      execute: "reply_execute", mutation: { method: "post", endpoint: "/api/outreach/conversations/conversation-1/reply", body: { mailbox_id: "mailbox-1", subject: "Re: Hello", body_text: "Thanks" } },
    },
    {
      prepare: "suppression_prepare", prepareInput: { scope: "email", target: "lead@example.com", reason: "Asked to stop" },
      execute: "suppression_execute", mutation: { method: "post", endpoint: "/api/suppressions", body: { email: "lead@example.com", reason: "Asked to stop" } },
    },
    {
      prepare: "delivery_mode_prepare", prepareInput: { dry_run: true },
      execute: "delivery_mode_execute", mutation: { method: "put", endpoint: "/api/runtime-settings" },
    },
    {
      prepare: "draft_bulk_action_prepare", prepareInput: { action: "cancel", draft_ids: ["draft-1"] },
      execute: "draft_bulk_action_execute", mutation: { method: "post", endpoint: "/api/outreach/drafts/bulk-delete", body: { delete_ids: [], cancel_ids: ["draft-1"] } },
    },
    {
      prepare: "attachment_delete_prepare", prepareInput: { attachment_id: "attachment-1" },
      execute: "attachment_delete_execute", mutation: { method: "delete", endpoint: "/api/attachments/attachment-1", body: undefined },
    },
    {
      prepare: "run_control", prepareInput: { phase: "prepare", action: "stop_followups", run_id: "run-1", lead_ids: ["lead-1"] },
      execute: "run_control", executeInput: { phase: "execute" }, mutation: { method: "post", endpoint: "/api/outreach/runs/run-1/stop-followups", body: { lead_ids: ["lead-1"] } },
    },
    {
      prepare: "run_control", prepareInput: { phase: "prepare", action: "stop_all" },
      execute: "run_control", executeInput: { phase: "execute" }, mutation: { method: "post", endpoint: "/api/outreach/stop-all", body: {} },
    },
    {
      prepare: "conversation_action", prepareInput: { phase: "prepare", action: "delay", conversation_id: "conversation-1", values: { until: "2026-10-20T09:00:00Z" } },
      execute: "conversation_action", executeInput: { phase: "execute", action: "delay" }, mutation: { method: "post", endpoint: "/api/outreach/conversations/conversation-1/delay", body: { until: "2026-10-20T09:00:00Z" } },
    },
    {
      prepare: "conversation_classify_prepare", prepareInput: { conversation_id: "conversation-1", classification: "unsubscribe" },
      execute: "conversation_classify_execute", mutation: { method: "patch", endpoint: "/api/outreach/conversations/conversation-1/classification", body: { classification: "unsubscribe" } },
    },
  ];

  for (const item of cases) {
    const { handlers, calls } = createProtectedFixture();
    const prepared = await handlers[item.prepare](item.prepareInput);
    const token = tokenOf(prepared);
    const noApproval = await handlers[item.execute]({ ...(item.executeInput || {}), confirmation_token: token, confirm: false });
    assert.equal(noApproval.isError, true, item.prepare);
    assert.equal(noApproval.structuredContent.data.code, "confirmation_required", item.prepare);
    assert.equal(calls.some((call) => call.endpoint === item.mutation.endpoint && call.method === item.mutation.method), false, item.prepare);

    const preparedAgain = await handlers[item.prepare](item.prepareInput);
    const executed = await handlers[item.execute]({ ...(item.executeInput || {}), confirmation_token: tokenOf(preparedAgain), confirm: true });
    assert.equal(executed.isError, undefined, `${item.prepare}: ${executed.content?.[0]?.text}`);
    const mutationCall = calls.findLast((call) => call.endpoint === item.mutation.endpoint && call.method === item.mutation.method);
    assert.ok(mutationCall, item.prepare);
    if (Object.hasOwn(item.mutation, "body")) assert.deepEqual(mutationCall.body, item.mutation.body, item.prepare);
  }
});

test("a downstream mutation failure still consumes the confirmation token", async () => {
  const { handlers, calls, state } = createProtectedFixture();
  const prepared = await handlers.reply_prepare({ conversation_id: "conversation-1", mailbox_id: "mailbox-1", subject: "Re", body_text: "Reply" });
  const token = tokenOf(prepared);
  state.failNextMutation = true;
  const failed = await handlers.reply_execute({ confirmation_token: token, confirm: true });
  assert.equal(failed.isError, true);
  const retried = await handlers.reply_execute({ confirmation_token: token, confirm: true });
  assert.equal(retried.isError, true);
  assert.equal(retried.structuredContent.data.code, "confirmation_not_found");
  assert.equal(calls.filter((call) => call.endpoint === "/api/outreach/conversations/conversation-1/reply").length, 1);
});

test("failed launch revalidation consumes the confirmation token", async () => {
  const { handlers, state } = createProtectedFixture();
  const prepared = await handlers.launch_prepare({ source: "drafts", draft_ids: ["draft-1"], mode: "auto" });
  const token = tokenOf(prepared);
  state.draftPreflight.ok = false;
  const failed = await handlers.launch_execute({ confirmation_token: token, confirm: true });
  assert.equal(failed.isError, true);
  state.draftPreflight.ok = true;
  const retry = await handlers.launch_execute({ confirmation_token: token, confirm: true });
  assert.equal(retry.structuredContent.data.code, "confirmation_not_found");
});

test("global stop requires unchanged impact after approval", async () => {
  const { handlers, calls, state } = createProtectedFixture();
  const prepared = await handlers.run_control({ phase: "prepare", action: "stop_all" });
  const token = tokenOf(prepared);
  state.stopAllImpact.followups += 1;
  state.stopAllImpact.active_queue += 1;

  const blocked = await handlers.run_control({ phase: "execute", confirmation_token: token, confirm: true });
  assert.equal(blocked.isError, true);
  assert.equal(blocked.structuredContent.data.code, "confirmation_state_changed");
  assert.equal(calls.some((call) => call.endpoint === "/api/outreach/stop-all" && call.method === "post"), false);
});

test("campaign enrollment and queue cancellation require prepared confirmation", async () => {
  const { handlers, calls } = createProtectedFixture();
  const enrollment = await handlers.campaign_enrollment_prepare({ action: "resume", campaign_id: "campaign-1", enrollment_ids: ["enrollment-2"] });
  assert.equal(calls.some((call) => call.endpoint === "/api/enrollments/enrollment-2/resume"), false);
  await handlers.campaign_enrollment_execute({ confirmation_token: tokenOf(enrollment), confirm: true });
  assert.equal(calls.some((call) => call.endpoint === "/api/enrollments/enrollment-2/resume"), true);

  const cancellation = await handlers.queue_cancel_prepare({ queue_ids: ["queue-1"] });
  assert.equal(calls.some((call) => call.endpoint === "/api/sending/queue-1/cancel"), false);
  await handlers.queue_cancel_execute({ confirmation_token: tokenOf(cancellation), confirm: true });
  assert.equal(calls.some((call) => call.endpoint === "/api/sending/queue-1/cancel"), true);
});
