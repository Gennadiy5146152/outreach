import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createOutreachMcpServer } from "../../src/mcp/create-server.js";

test("MCP server initializes, lists tools, and calls a read tool with structured output", async () => {
  const fakeClient = {
    async get(endpoint) {
      if (endpoint === "/api/health") return { ok: true, dryRun: true };
      if (endpoint === "/api/settings") return { runtime: { dryRun: true, timeZone: "Europe/Moscow" } };
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  };
  const server = createOutreachMcpServer({ client: fakeClient });
  const client = new Client({ name: "outreach-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    assert.ok(listed.tools.length >= 35);
    assert.equal(listed.tools.some((tool) => tool.name === "launch_execute" && tool.annotations?.destructiveHint === true), true);
    assert.equal(listed.tools.some((tool) => tool.name === "personalization_pilot_execute" && tool.annotations?.destructiveHint === true), true);

    const result = await client.callTool({ name: "outreach_status", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].type, "text");
    assert.deepEqual(result.structuredContent.data, {
      health: { ok: true, dryRun: true },
      settings: { runtime: { dryRun: true, timeZone: "Europe/Moscow" } },
    });
  } finally {
    await client.close();
    await server.close();
  }
});
