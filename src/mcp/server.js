import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { env } from "../config/env.js";
import { createOutreachMcpServer } from "./create-server.js";
import { createOutreachClient } from "./outreach-client.js";
import { createCabinetMcpServer } from "./cabinet-server.js";

if (!env.mcpApiToken) {
  console.error("Outreach MCP cannot start: MCP_API_TOKEN is required.");
  process.exit(1);
}

if (env.mcpApiToken.startsWith("ocp_")) {
  const url = new URL(env.outreachBaseUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (env.outreachAllowHttp || ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw new Error("Private cabinet MCP requires HTTPS or explicit OUTREACH_ALLOW_HTTP=true.");
  }
  const client = createOutreachClient({ baseUrl: env.outreachBaseUrl, token: env.mcpApiToken, timeoutMs: env.mcpRequestTimeoutMs });
  const context = await client.get("/api/cabinet/mcp/context");
  void serveStdio(() => createCabinetMcpServer({ client, scopes: context.scopes }));
} else {
  void serveStdio(() => createOutreachMcpServer());
}
console.error("Outreach MCP is listening on stdio.");
