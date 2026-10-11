import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { env } from "../config/env.js";
import { createOutreachMcpServer } from "./create-server.js";

if (!env.mcpApiToken) {
  console.error("Outreach MCP cannot start: MCP_API_TOKEN is required.");
  process.exit(1);
}

void serveStdio(() => createOutreachMcpServer());
console.error("Outreach MCP is listening on stdio.");
