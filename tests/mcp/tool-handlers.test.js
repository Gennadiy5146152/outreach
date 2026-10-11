import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_DEFINITIONS } from "../../src/mcp/tool-definitions.js";
import { createToolHandlers } from "../../src/mcp/tool-handlers.js";

function fakeClient() {
  const calls = [];
  const client = {};
  for (const method of ["get", "post", "patch", "put", "delete", "upload"]) {
    client[method] = async (...args) => {
      calls.push({ method, args });
      return {
        ok: true,
        method,
        path: args[0],
        password: "mailbox-password",
        nested: {
          authorization: "Bearer hidden",
          database_url: "postgres://hidden",
          raw_headers: { received: "private" },
          safe: "visible",
        },
      };
    };
  }
  return { client, calls };
}

function dataOf(result) {
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].type, "text");
  assert.equal(typeof result.structuredContent.summary, "string");
  assert.equal(Array.isArray(result.structuredContent.next_actions), true);
  return result.structuredContent.data;
}

test("catalog exposes the approved domain tools with bounded schemas", () => {
  const names = new Set(TOOL_DEFINITIONS.map((item) => item.name));
  for (const name of [
    "outreach_status", "outreach_dashboard", "events_list",
    "leads_list", "lead_upsert", "leads_import",
    "drafts_list", "draft_update", "drafts_preflight", "draft_bulk_action_prepare", "draft_bulk_action_execute",
    "attachment_upload", "attachment_delete_prepare", "attachment_delete_execute",
    "launch_prepare", "launch_execute", "campaigns_list", "campaign_manage", "campaign_enrollment_prepare", "campaign_enrollment_execute",
    "queue_list", "queue_approval_prepare", "queue_approval_execute", "queue_cancel_prepare", "queue_cancel_execute",
    "runs_list", "run_get", "run_control", "conversations_list", "conversation_get",
    "conversation_classify", "conversation_classify_prepare", "conversation_classify_execute", "conversation_action", "reply_prepare", "reply_execute",
    "suppressions_list", "suppression_prepare", "suppression_execute",
    "mailboxes_list", "mailbox_check", "inbox_sync",
    "delivery_mode_prepare", "delivery_mode_execute",
  ]) assert.equal(names.has(name), true, `missing tool ${name}`);

  assert.equal(TOOL_DEFINITIONS.every((item) => item.inputSchema && item.description && item.annotations), true);
  assert.equal(TOOL_DEFINITIONS.filter((item) => item.name.endsWith("_execute")).every((item) => item.annotations.destructiveHint === true), true);
});

test("entity identifiers reject URL path injection", () => {
  const campaign = TOOL_DEFINITIONS.find((item) => item.name === "campaign_manage");
  const result = campaign.inputSchema.safeParse({
    action: "update",
    campaign_id: "11111111-1111-4111-8111-111111111111/start#",
    values: { mode: "auto", force: true },
  });
  assert.equal(result.success, false);
});

test("read handlers map to the existing Outreach API and cap pagination", async () => {
  const { client, calls } = fakeClient();
  const handlers = createToolHandlers({ client, confirmations: {} });
  const cases = [
    ["outreach_dashboard", {}, "/api/dashboard"],
    ["events_list", { page: 0, page_size: 999 }, "/api/events"],
    ["leads_list", { page: 2, page_size: 999, status: "new" }, "/api/leads"],
    ["drafts_list", { page: 1, page_size: 999, status: "ready" }, "/api/outreach/drafts"],
    ["campaigns_list", {}, "/api/campaigns"],
    ["queue_list", { page: 3, page_size: 999, filter: "waiting" }, "/api/sending"],
    ["runs_list", { page: 1, page_size: 999 }, "/api/outreach/runs"],
    ["run_get", { run_id: "run-1" }, "/api/outreach/runs/run-1"],
    ["conversations_list", { page: 4, page_size: 999, status: "needs_review" }, "/api/outreach/conversations"],
    ["conversation_get", { conversation_id: "conversation-1" }, "/api/outreach/conversations/conversation-1"],
    ["suppressions_list", {}, "/api/suppressions"],
    ["mailboxes_list", {}, "/api/mailboxes"],
  ];

  for (const [name, input, expectedPath] of cases) {
    const before = calls.length;
    const result = await handlers[name](input);
    assert.equal(calls.length, before + 1, name);
    assert.equal(calls.at(-1).method, "get", name);
    assert.equal(calls.at(-1).args[0], expectedPath, name);
    dataOf(result);
  }

  const pagedCalls = calls.filter((call) => call.args[1]?.query?.pageSize);
  assert.equal(pagedCalls.every((call) => call.args[1].query.pageSize === 100), true);
  assert.equal(pagedCalls.find((call) => call.args[0] === "/api/events").args[1].query.page, 1);
});

test("status combines health and safe settings while recursively removing secrets", async () => {
  const calls = [];
  const client = {
    async get(endpoint) {
      calls.push(endpoint);
      if (endpoint === "/api/health") return { ok: true, dryRun: true };
      return {
        runtime: { dryRun: true },
        password_env_key: "MAILBOX_SECRET",
        authToken: "hidden",
        nested: { safe: "visible", cookie: "hidden", raw_headers: { private: true } },
      };
    },
  };
  const handlers = createToolHandlers({ client, confirmations: {} });
  const data = dataOf(await handlers.outreach_status({}));

  assert.deepEqual(calls, ["/api/health", "/api/settings"]);
  assert.deepEqual(data, {
    health: { ok: true, dryRun: true },
    settings: { runtime: { dryRun: true }, nested: { safe: "visible" } },
  });
  assert.equal(JSON.stringify(data).includes("hidden"), false);
});

test("ordinary mutation handlers map exact actions to HTTP methods and bodies", async () => {
  const { client, calls } = fakeClient();
  const handlers = createToolHandlers({ client, confirmations: {} });
  const cases = [
    ["lead_upsert", { lead: { company: "A", email: "a@example.com" } }, "post", "/api/leads", { company: "A", email: "a@example.com" }],
    ["lead_upsert", { lead_id: "lead-1", lead: { company: "B" } }, "patch", "/api/leads/lead-1", { company: "B" }],
    ["drafts_preflight", { draft_ids: ["draft-1"] }, "post", "/api/outreach/drafts/preflight", { draft_ids: ["draft-1"] }],
    ["campaign_manage", { action: "create", values: { name: "Campaign" } }, "post", "/api/campaigns", { name: "Campaign" }],
    ["campaign_manage", { action: "add_step", campaign_id: "campaign-1", values: { name: "Step" } }, "post", "/api/campaigns/campaign-1/steps", { name: "Step" }],
    ["conversation_classify", { conversation_id: "conversation-1", classification: "neutral_reply" }, "patch", "/api/outreach/conversations/conversation-1/classification", { classification: "neutral_reply" }],
    ["mailbox_check", { mailbox_id: "mailbox-1" }, "post", "/api/mailboxes/mailbox-1/check", {}],
    ["inbox_sync", {}, "post", "/api/inbox/sync", {}],
  ];

  for (const [name, input, method, endpoint, body] of cases) {
    await handlers[name](input);
    assert.deepEqual(calls.at(-1), { method, args: [endpoint, body] }, name);
  }
});

test("partial draft and campaign updates merge current state before replacement APIs", async () => {
  const calls = [];
  const client = {
    async get(endpoint) {
      calls.push({ method: "get", endpoint });
      if (endpoint === "/api/outreach/drafts/draft-1/review") {
        return { id: "draft-1", to_email: "lead@example.com", company: "A", contact_name: "Ann", segment: "S", subject: "Old", body_text: "Body", body_html: "<p>Body</p>", mailbox_id: "mailbox-1", send_after: null, steps: [{ position: 2, subject: "FU", body_text: "Follow", body_html: "", delay_days: 3 }] };
      }
      if (endpoint === "/api/campaigns/campaign-1/review") {
        return { campaign: { id: "campaign-1", name: "Old", description: "Description", segment: "S", tracking_enabled: true, manual_approval_required: false, steps: [{ id: "step-1", name: "FU", delay_days: 2, subject_template: "Old", body_template_text: "Body", body_template_html: "" }] }, active_enrollments: [] };
      }
      throw new Error(endpoint);
    },
    async patch(endpoint, body) { calls.push({ method: "patch", endpoint, body }); return body; },
    async put(endpoint, body) { calls.push({ method: "put", endpoint, body }); return body; },
  };
  const handlers = createToolHandlers({ client, confirmations: {} });

  await handlers.draft_update({ action: "draft", draft_id: "draft-1", values: { subject: "New" } });
  assert.deepEqual(calls.at(-1).body, { to_email: "lead@example.com", company: "A", contact_name: "Ann", segment: "S", subject: "New", body_text: "Body", body_html: "<p>Body</p>", mailbox_id: "mailbox-1", send_after: null });
  await handlers.draft_update({ action: "step", draft_id: "draft-1", position: 2, values: { subject: "New FU" } });
  assert.deepEqual(calls.at(-1).body, { subject: "New FU", body_text: "Follow", body_html: "", delay_days: 3 });
  await handlers.campaign_manage({ action: "update", campaign_id: "campaign-1", values: { name: "New" } });
  assert.deepEqual(calls.at(-1).body, { name: "New", description: "Description", segment: "S", tracking_enabled: true, manual_approval_required: false });
  await handlers.campaign_manage({ action: "update_step", step_id: "step-1", campaign_id: "campaign-1", values: { subject_template: "New subject" } });
  assert.deepEqual(calls.at(-1).body, { name: "FU", delay_days: 2, subject_template: "New subject", body_template_text: "Body", body_template_html: "" });
});

test("file tools validate intent and use the correct upload endpoint", async () => {
  const { client, calls } = fakeClient();
  const handlers = createToolHandlers({ client, confirmations: {} });

  await handlers.leads_import({ kind: "outreach", file_path: "/tmp/leads.xlsx", mapping: { email: 0 } });
  assert.deepEqual(calls.at(-1), {
    method: "upload",
    args: ["/api/outreach/imports", {
      filePath: "/tmp/leads.xlsx",
      fields: { mapping: JSON.stringify({ email: 0 }) },
      allowedExtensions: [".csv", ".xlsx"],
      maxBytes: 50 * 1024 * 1024,
    }],
  });

  await handlers.leads_import({ kind: "leads", file_path: "/tmp/leads.csv" });
  assert.equal(calls.at(-1).args[0], "/api/leads/import");
  assert.deepEqual(calls.at(-1).args[1].allowedExtensions, [".csv"]);

  await handlers.attachment_upload({ target: "outreach_step", target_id: "step-1", file_path: "/tmp/proposal.pdf" });
  assert.equal(calls.at(-1).args[0], "/api/outreach/draft-steps/step-1/attachments");
  await handlers.attachment_upload({ target: "campaign_step", target_id: "step-2", file_path: "/tmp/proposal.pdf" });
  assert.equal(calls.at(-1).args[0], "/api/steps/step-2/attachments");
});

test("all handler results remove sensitive keys at any depth", async () => {
  const { client } = fakeClient();
  const handlers = createToolHandlers({ client, confirmations: {} });
  const result = await handlers.leads_list({});
  const serialized = JSON.stringify(result);
  for (const forbidden of ["mailbox-password", "Bearer hidden", "postgres://hidden", "private", "raw_headers"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(serialized.includes("visible"), true);
});
