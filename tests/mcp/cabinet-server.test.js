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
test('today batch is cabinet-wide send+draft scoped and bounds twenty stored recipients with a mandatory plan',async()=>{
 for(const [scopes,allCampaigns] of [[["outreach:send"],true],[["outreach:draft"],true],[["outreach:send","outreach:draft"],false]])await session(scopes,async client=>assert.equal((await client.listTools()).tools.some(t=>t.name==='telegram_today_batch_prepare'),false),{allCampaigns});
 await session(['outreach:send','outreach:draft'],async(client,calls)=>{
  const input={campaign_id:'00000000-0000-4000-8000-000000000001',draft_ids:Array.from({length:20},(_,i)=>`00000000-0000-4000-8000-${String(i+10).padStart(12,'0')}`),window_start:'12:02',window_end:'15:55'};
  for(const bad of [{...input,draft_ids:[...input.draft_ids,'00000000-0000-4000-8000-000000000099']},{...input,include_weekends:true},{...input,daily_limit:100},{...input,body:'ad hoc message'},{...input,one_off_day:'2026-11-28'}])assert.equal((await client.callTool({name:'telegram_today_batch_prepare',arguments:bad})).isError,true);
  assert.equal(calls.length,0);const plan=await client.callTool({name:'telegram_today_batch_prepare',arguments:input});assert.equal(plan.isError,undefined);assert.equal(plan.structuredContent.data.requires_confirmation,true);
  const {campaign_id,...body}=input;assert.deepEqual(calls,[{path:`/api/cabinet/campaigns/${campaign_id}/today-batch/prepare`,input:body}]);
 },{allCampaigns:true});
});
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
        "campaign_stats_get",
        "campaign_response_stats_get",
        "campaign_response_schedule_get",
        "outreach_media_list",
        "outreach_reviews_list",
        "outreach_followups_list",
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
test('conversion tools are read scoped; outcome edits require read+draft and cannot change delivery',async()=>{
 const campaign_id='00000000-0000-4000-8000-000000000001',job_id='00000000-0000-4000-8000-000000000002';
 await session(['outreach:read'],async(client,calls)=>{
  const tools=(await client.listTools()).tools;assert.ok(tools.some(t=>t.name==='campaign_stats_get'));
  assert.equal(tools.some(t=>t.name==='outreach_outcome_update'),false);
  await client.callTool({name:'campaign_stats_get',arguments:{campaign_id,from:'2026-11-27',to:'2026-11-27'}});
  assert.equal(calls[0],`/api/cabinet/campaigns/${campaign_id}/stats`);
 });
 await session(['outreach:read','outreach:draft'],async(client,calls)=>{
  const base={campaign_id,job_id,status:'interested',reason:'Просит цену',expected_snapshot:'a'.repeat(32),evidence_message_ids:['123']};
  for(const extra of [{status:'sent'},{owner_id:campaign_id},{source:'manual'},{scheduled_at:'tomorrow'},{evidence_message_ids:[]},{expected_snapshot:'bad'}]){
   assert.equal((await client.callTool({name:'outreach_outcome_update',arguments:{...base,...extra}})).isError,true);
  }
  assert.equal(calls.length,0);
  await client.callTool({name:'outreach_outcome_update',arguments:base});
  assert.equal(calls[0].path,`/api/cabinet/campaigns/${campaign_id}/reviews/${job_id}`);
  assert.equal(calls[0].input.status,'interested');
 });
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

test('one-off tools require cabinet-wide send plus draft and accept only two stored drafts with a time window',async()=>{
  for(const [scopes,allCampaigns] of [[['outreach:send'],true],[['outreach:draft'],true],[['outreach:send','outreach:draft'],false]])await session(scopes,async client=>assert.equal((await client.listTools()).tools.some(t=>t.name.startsWith('telegram_one_off_')),false),{allCampaigns});
  await session(['outreach:send','outreach:draft'],async(client,calls)=>{
    const names=(await client.listTools()).tools.map(t=>t.name);assert.ok(names.includes('telegram_one_off_prepare'));assert.ok(names.includes('telegram_one_off_execute'));
    const input={campaign_id:'00000000-0000-4000-8000-000000000001',draft_ids:['00000000-0000-4000-8000-000000000002'],window_start:'14:00',window_end:'15:00'};
    for(const invalid of [{...input,day:'2026-11-27'},{...input,daily_limit:101},{...input,body:'ad hoc'},{...input,draft_ids:[]},{...input,draft_ids:[...input.draft_ids,...input.draft_ids]},{...input,draft_ids:[...input.draft_ids,'00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004']},{...input,window_end:'25:00'},{...input,window_end:'13:00'}])assert.equal((await client.callTool({name:'telegram_one_off_prepare',arguments:invalid})).isError,true);
    assert.equal(calls.length,0);await client.callTool({name:'telegram_one_off_prepare',arguments:input});const {campaign_id,...body}=input;assert.deepEqual(calls[0],{path:`/api/cabinet/campaigns/${campaign_id}/one-off/prepare`,input:body});
    await client.callTool({name:'telegram_one_off_prepare',arguments:{...input,daily_limit:20}});assert.deepEqual(calls.pop(),{path:`/api/cabinet/campaigns/${campaign_id}/one-off/prepare`,input:{...body,daily_limit:20}});
    for(const campaign_window_end of ['25:00',null,15])assert.equal((await client.callTool({name:'telegram_one_off_prepare',arguments:{...input,campaign_window_end}})).isError,true);
    await client.callTool({name:'telegram_one_off_prepare',arguments:{...input,daily_limit:20,campaign_window_end:'15:55'}});assert.deepEqual(calls.pop(),{path:`/api/cabinet/campaigns/${campaign_id}/one-off/prepare`,input:{...body,daily_limit:20,campaign_window_end:'15:55'}});
    const confirmation={confirmation_token:'plan_123456789012345678901234567890',confirm:true};for(const invalid of [{...confirmation,confirm:false},{...confirmation,kind:'launch'},{...confirmation,scheduled_at:'2026-11-27'}])assert.equal((await client.callTool({name:'telegram_one_off_execute',arguments:invalid})).isError,true);
    await client.callTool({name:'telegram_one_off_execute',arguments:confirmation});assert.deepEqual(calls[1],{path:'/api/cabinet/one-off/execute',input:confirmation});
  },{allCampaigns:true});
});

test('draft_create accepts exactly one personal address mode and never permits source identity edits',async()=>{
  await session(['outreach:draft'],async(client,calls)=>{
    const source={chat_id:'9223372036854775807',username:'public_group',message_id:2147483647};
    const input={campaign_id:'00000000-0000-4000-8000-000000000001',recipient_id:'9007199254740993',body:'Exact copy',recipient_source:source};
    for(const recipient_source of [null,[],{},'group',{...source,extra:true},{...source,chat_id:123},{...source,chat_id:'0'},{...source,chat_id:'9223372036854775808'},{...source,username:'Public_Group'},{...source,username:'@public_group'},{...source,message_id:0},{...source,message_id:2147483648},{...source,message_id:'123'}])assert.equal((await client.callTool({name:'draft_create',arguments:{...input,recipient_source}})).isError,true);
    assert.equal((await client.callTool({name:'draft_create',arguments:{...input,address:'https://t.me/not_the_author'}})).isError,true);assert.equal(calls.length,0);
    const saved=await client.callTool({name:'draft_create',arguments:input});assert.notEqual(saved.isError,true);const {campaign_id,...body}=input;assert.deepEqual(calls[0],{path:`/api/cabinet/campaigns/${campaign_id}/drafts`,input:{...body,name:''}});
    await client.callTool({name:'draft_create',arguments:{campaign_id,recipient_id:'9912345',body:'Legacy copy',address:'https://t.me/legacy_person'}});assert.equal(calls[1].input.address,'https://t.me/legacy_person');assert.equal(Object.hasOwn(calls[1].input,'recipient_source'),false);
    assert.equal((await client.callTool({name:'draft_update',arguments:{campaign_id,draft_id:'00000000-0000-4000-8000-000000000002',recipient_source:source}})).isError,true);
  });
});

test('deferred worklist is read-only and strictly scoped, with no automatic date edits',async()=>{
 await session(['outreach:read'],async(client,calls)=>{
  const names=(await client.listTools()).tools.map(t=>t.name);assert.ok(names.includes('outreach_followups_list'));assert.ok(!names.includes('outreach_followup_update'));
  const campaign_id='00000000-0000-4000-8000-000000000001';
  for(const extra of [{view:'yesterday'},{page:0},{page_size:101},{follow_up_on:'2026-12-12'},{owner_id:campaign_id}])assert.equal((await client.callTool({name:'outreach_followups_list',arguments:{campaign_id,...extra}})).isError,true);
  assert.equal(calls.length,0);await client.callTool({name:'outreach_followups_list',arguments:{campaign_id,view:'due'}});assert.deepEqual(calls,[`/api/cabinet/campaigns/${campaign_id}/followups`]);
 });
});

test('all response analytics and media metadata are read scoped, without calendar or file-path writes',async()=>{
 await session(['outreach:read'],async(client,calls)=>{
  const campaign_id='00000000-0000-4000-8000-000000000001',names=(await client.listTools()).tools.map(t=>t.name);
  for(const name of ['campaign_response_stats_get','campaign_response_schedule_get','outreach_media_list'])assert.ok(names.includes(name));
  assert.ok(!names.includes('campaign_response_schedule_update'));
  for(const extra of [{mode:'business'},{side:'manager'},{status:'success'},{page_size:101},{start:'09:00'},{file_path:'/etc/hosts'}])assert.equal((await client.callTool({name:'campaign_response_stats_get',arguments:{campaign_id,...extra}})).isError,true);
  assert.equal((await client.callTool({name:'outreach_media_list',arguments:{campaign_id,storage_key:'outside'}})).isError,true);assert.equal(calls.length,0);
  await client.callTool({name:'campaign_response_stats_get',arguments:{campaign_id,mode:'working',side:'artem',status:'pending'}});await client.callTool({name:'campaign_response_schedule_get',arguments:{campaign_id}});await client.callTool({name:'outreach_media_list',arguments:{campaign_id}});
  assert.deepEqual(calls,[`/api/cabinet/campaigns/${campaign_id}/response-analytics`,`/api/cabinet/campaigns/${campaign_id}/response-schedule`,`/api/cabinet/campaigns/${campaign_id}/media`]);
 });
});
