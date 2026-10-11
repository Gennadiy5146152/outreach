const SENSITIVE_KEY = /(authorization|cookie|password|secret|token|database[_-]?url|raw[_-]?headers)/i;

export function redactData(value, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactData(item, seen));
  if (value instanceof Date) return value.toISOString();
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key === "confirmation_token" || !SENSITIVE_KEY.test(key))
      .map(([key, item]) => [key, redactData(item, seen)]),
  );
}

export function toolSuccess(summary, data, nextActions = []) {
  const safeSummary = String(summary || "Готово");
  return {
    content: [{ type: "text", text: safeSummary }],
    structuredContent: {
      summary: safeSummary,
      data: redactData(data),
      next_actions: [...nextActions],
    },
  };
}

export function toolError(error) {
  const summary = String(error?.message || "Outreach MCP operation failed").slice(0, 600);
  return {
    isError: true,
    content: [{ type: "text", text: summary }],
    structuredContent: {
      summary,
      data: redactData({
        code: error?.code || "outreach_mcp_error",
        status: error?.status || null,
        details: error?.details || null,
      }),
      next_actions: [],
    },
  };
}

export function safeTool(handler) {
  return async (input = {}) => {
    try {
      return await handler(input);
    } catch (error) {
      return toolError(error);
    }
  };
}
