import { McpServer } from "@modelcontextprotocol/server";
import { env } from "../config/env.js";
import { createConfirmationStore } from "./confirmation-store.js";
import { createOutreachClient } from "./outreach-client.js";
import { TOOL_DEFINITIONS } from "./tool-definitions.js";
import { createToolHandlers } from "./tool-handlers.js";

const SERVER_INSTRUCTIONS = [
  "Use prepare tools before every delivery or high-impact mutation.",
  "After prepare, show the returned summary to the human and ask for explicit permission.",
  "Call an execute tool only after the human approves in the current conversation; never infer approval.",
  "If state changes or a token expires, prepare again. Prefer filtered, paginated reads.",
].join(" ");

export function createOutreachMcpServer({ client, confirmations } = {}) {
  const apiClient = client || createOutreachClient({
    baseUrl: env.outreachBaseUrl,
    token: env.mcpApiToken,
    timeoutMs: env.mcpRequestTimeoutMs,
  });
  const confirmationStore = confirmations || createConfirmationStore({
    ttlSeconds: env.mcpConfirmationTtlSeconds,
  });
  const handlers = createToolHandlers({ client: apiClient, confirmations: confirmationStore });
  const server = new McpServer(
    { name: "outreach-desk", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  for (const tool of TOOL_DEFINITIONS) {
    const handler = handlers[tool.name];
    if (!handler) throw new Error(`Missing MCP handler for ${tool.name}`);
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (input) => handler(input),
    );
  }

  return server;
}
