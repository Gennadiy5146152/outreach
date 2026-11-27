import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createCabinetMcpServer } from "../../src/mcp/cabinet-server.js";

async function session(scopes, fn, options = {}) {
  const calls = [];
  const api = {
    get: async (path) => {
      calls.push(path);
      return { allowed: true };
    },
    patch: async (path, input) => { calls.push({ path, input }); return input; },
    post: async (path, input) => {
      calls.push({ path, input });
      return {
        confirmation_token: "plan_123456789012345678901234567890",
        preview: { items: [{ body: "Точный текст" }] },
        requires_confirmation: true,
      };
    },
  };
  const server = createCabinetMcpServer({ client: api, scopes, ...options });
  const client = new Client({ name: "cabinet-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    await fn(client, calls);
  } finally {
    await client.close();
    await server.close();
  }
}
test("Instagram status is independently scoped and cannot connect, send or read Direct", async () => {
  await session(["instagram:read"], async (client, calls) => {
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ["cabinet_access", "instagram_connections_list"]);
    await client.callTool({ name: "instagram_connections_list", arguments: {} });
    assert.deepEqual(calls, ["/api/cabinet/instagram"]);
  });
});
test("only cabinet-wide draft tokens can select senders and create bounded empty campaigns", async () => {
  for (const [scopes, allCampaigns] of [
    [["outreach:draft"], false],
    [["outreach:read", "outreach:send"], true],
  ]) {
    await session(scopes, async client => {
      const names = (await client.listTools()).tools.map(t => t.name);
      assert.equal(names.includes("campaign_create"), false);
      assert.equal(names.includes("campaign_connections_list"), false);
    }, { allCampaigns });
  }
  await session(["outreach:draft"], async (client, calls) => {
    const names = (await client.listTools()).tools.map(t => t.name);
    assert.ok(names.includes("campaign_create"));
    assert.ok(names.includes("campaign_connections_list"));
    const input = {
      connection_id: "00000000-0000-4000-8000-000000000001",
      name: "Reviewed messages",
    };
    for (const invalid of [
      { ...input, daily_limit: 0 },
      { ...input, daily_limit: 101 },
      { ...input, window_start: "25:00" },
      { ...input, owner_id: "00000000-0000-4000-8000-000000000002" },
      { ...input, paused: false },
    ]) {
      assert.equal((await client.callTool({ name: "campaign_create", arguments: invalid })).isError, true);
    }
    assert.equal(calls.length, 0);
    await client.callTool({ name: "campaign_connections_list", arguments: {} });
    assert.equal(calls[0], "/api/cabinet/campaign-connections");
    await client.callTool({ name: "campaign_create", arguments: input });
    assert.deepEqual(calls[1], {
      path: "/api/cabinet/campaigns",
      input: { ...input, daily_limit: 10, window_start: "09:30", window_end: "11:30" },
    });
  }, { allCampaigns: true });
});
test("scoped MCP advertises only granted tools, no account, QR or arbitrary history endpoints", async () => {
  await session(["outreach:read"], async (client, calls) => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.deepEqual(
      names.sort(),
      [
        "cabinet_access",
        "campaigns_list",
        "drafts_list",
        "outreach_thread_get",
        "queue_list",
      ].sort(),
    );
    await assert.rejects(
      client.callTool({
        name: "telegram_launch_execute",
        arguments: {
          confirmation_token: "plan_12345678901234567890",
          confirm: true,
        },
      }),
      /not found/,
    );
    assert.equal(calls.length, 0);
    await client.callTool({
      name: "outreach_thread_get",
      arguments: {
        campaign_id: "00000000-0000-4000-8000-000000000001",
        job_id: "00000000-0000-4000-8000-000000000002",
      },
    });
    assert.match(
      calls[0],
      /^\/api\/cabinet\/campaigns\/[^/]+\/threads\/[^/]+$/,
    );
  });
  await session([], async (client) =>
    assert.deepEqual(
      (await client.listTools()).tools.map((t) => t.name),
      ["cabinet_access"],
    ),
  );
});
test("send scope accepts stored draft IDs only, preserves confirmation preview and rejects ad hoc bodies", async () => {
  await session(["outreach:send"], async (client, calls) => {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(
      tools.map((x) => x.name).sort(),
      [
        "cabinet_access",
        "telegram_launch_prepare",
        "telegram_launch_execute",
      ].sort(),
    );
    const args = {
      campaign_id: "00000000-0000-4000-8000-000000000001",
      draft_ids: ["00000000-0000-4000-8000-000000000002"],
    };
    const invalid = await client.callTool({
      name: "telegram_launch_prepare",
      arguments: { ...args, body: "Arbitrary message" },
    });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 0);
    const plan = await client.callTool({
      name: "telegram_launch_prepare",
      arguments: args,
    });
    assert.equal(
      plan.structuredContent.data.preview.items[0].body,
      "Точный текст",
    );
    assert.ok(
      plan.structuredContent.data.confirmation_token.startsWith("plan_"),
    );
    assert.equal(calls.length, 1);
    const denied = await client.callTool({
      name: "telegram_launch_execute",
      arguments: {
        confirmation_token: "plan_123456789012345678901234567890",
        confirm: false,
      },
    });
    assert.equal(denied.isError, true);
    assert.equal(calls.length, 1);
  });
});

test("draft_update accepts paired evidence or body without identity edits", async () => {
  await session(["outreach:draft"], async (client, calls) => {
    const ids = { campaign_id: "00000000-0000-4000-8000-000000000001", draft_id: "00000000-0000-4000-8000-000000000002" };
    const evidence = { permission_kind: "request", permission_evidence: "Dated genuine request", source_url: "https://t.me/example/123" };
    assert.equal((await client.callTool({ name: "draft_update", arguments: { ...ids, ...evidence } })).isError, undefined);
    assert.deepEqual(calls[0], { path: `/api/cabinet/campaigns/${ids.campaign_id}/drafts/${ids.draft_id}`, input: evidence });
    for (const value of [{}, { permission_kind: "request" }, { permission_evidence: "Request" }, { body: "Hello", recipient_id: "123" }]) assert.equal((await client.callTool({ name: "draft_update", arguments: { ...ids, ...value } })).isError, true);
    assert.equal(calls.length, 1);
  });
});
test("idle window MCP is all-campaigns draft scoped and cannot change daily limit or pause", async () => {
  await session(["outreach:draft"], async client => assert.equal((await client.listTools()).tools.some(t => t.name === "campaign_window_update"), false));
  await session(["outreach:send"], async client => assert.equal((await client.listTools()).tools.some(t => t.name === "campaign_window_update"), false), { allCampaigns: true });
  await session(["outreach:draft"], async (client, calls) => {
    const input = { campaign_id: "00000000-0000-4000-8000-000000000001", window_start: "09:30", window_end: "14:00" };
    await client.callTool({ name: "campaign_window_update", arguments: input });
    assert.deepEqual(calls[0], { path: `/api/cabinet/campaigns/${input.campaign_id}/window`, input: { window_start: "09:30", window_end: "14:00" } });
    for (const extra of [{ paused: false }, { daily_limit: 100 }]) assert.equal((await client.callTool({ name: "campaign_window_update", arguments: { ...input, ...extra } })).isError, true);
    assert.equal(calls.length, 1);
  }, { allCampaigns: true });
});

test('queued copy tools require both send and draft, expose exact prepare and forbid identity or delivery controls', async()=>{
  for(const scopes of [['outreach:send'],['outreach:draft'],['outreach:read']]) await session(scopes,async client=>assert.equal((await client.listTools()).tools.some(t=>t.name.startsWith('telegram_queue_edit_')),false));
  await session(['outreach:send','outreach:draft'],async(client,calls)=>{
    const names=(await client.listTools()).tools.map(t=>t.name); assert.ok(names.includes('telegram_queue_edit_prepare')); assert.ok(names.includes('telegram_queue_edit_execute'));
    const input={campaign_id:'00000000-0000-4000-8000-000000000001',items:[{job_id:'00000000-0000-4000-8000-000000000002',body:'Exact replacement'}]};
    for(const invalid of [{...input,paused:false},{...input,items:[{...input.items[0],recipient_id:'123'}]},{...input,items:[{...input.items[0],scheduled_at:'2030-01-01'}]},{...input,items:[]},{...input,items:[input.items[0],input.items[0]]},{...input,items:[{...input.items[0],body:' '.repeat(2)}]}]) assert.equal((await client.callTool({name:'telegram_queue_edit_prepare',arguments:invalid})).isError,true);
    assert.equal(calls.length,0);
    await client.callTool({name:'telegram_queue_edit_prepare',arguments:input});
    assert.deepEqual(calls[0],{path:`/api/cabinet/campaigns/${input.campaign_id}/queue-edit/prepare`,input:{items:input.items}});
    const confirmation={confirmation_token:'plan_123456789012345678901234567890',confirm:true};
    assert.equal((await client.callTool({name:'telegram_queue_edit_execute',arguments:{...confirmation,confirm:false}})).isError,true);
    assert.equal((await client.callTool({name:'telegram_queue_edit_execute',arguments:{...confirmation,paused:false}})).isError,true);
    await client.callTool({name:'telegram_queue_edit_execute',arguments:confirmation});
    assert.deepEqual(calls[1],{path:'/api/cabinet/queue-edit/execute',input:confirmation});
  });
});
