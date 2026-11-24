import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createCabinetMcpServer } from "../../src/mcp/cabinet-server.js";

async function session(scopes, fn) {
  const calls = [];
  const api = {
    get: async (path) => {
      calls.push(path);
      return { allowed: true };
    },
    post: async (path, input) => {
      calls.push({ path, input });
      return {
        confirmation_token: "plan_123456789012345678901234567890",
        preview: { items: [{ body: "Точный текст" }] },
        requires_confirmation: true,
      };
    },
  };
  const server = createCabinetMcpServer({ client: api, scopes });
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
