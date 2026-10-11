import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { createOutreachClient } from "../../src/mcp/outreach-client.js";
import { OutreachApiError } from "../../src/mcp/errors.js";

async function withServer(handler, run) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("GET requests carry bearer auth and encode bounded query values", async () => {
  await withServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer dedicated-token");
    assert.equal(request.url, "/api/leads?page=2&tags=one&tags=two&active=true");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ items: [{ id: "lead-1" }] }));
  }, async (baseUrl) => {
    const client = createOutreachClient({ baseUrl, token: "dedicated-token" });
    const result = await client.get("/api/leads", {
      query: { page: 2, tags: ["one", "two"], empty: null, active: true },
    });
    assert.deepEqual(result, { items: [{ id: "lead-1" }] });
  });
});

test("JSON mutations send the requested method and body", async () => {
  await withServer(async (request, response) => {
    assert.equal(request.method, "PATCH");
    assert.match(request.headers["content-type"], /^application\/json/);
    assert.deepEqual(JSON.parse((await readBody(request)).toString("utf8")), { status: "ready" });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    const client = createOutreachClient({ baseUrl, token: "dedicated-token" });
    assert.deepEqual(await client.patch("/api/drafts/1", { status: "ready" }), { ok: true });
  });
});

test("multipart uploads preserve filename and fields", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "outreach-mcp-client-"));
  const filePath = path.join(directory, "leads.csv");
  await writeFile(filePath, "email,company\nhello@example.com,Example\n");
  try {
    await withServer(async (request, response) => {
      assert.equal(request.headers.authorization, "Bearer dedicated-token");
      assert.match(request.headers["content-type"], /^multipart\/form-data; boundary=/);
      const body = (await readBody(request)).toString("utf8");
      assert.match(body, /filename="leads.csv"/);
      assert.match(body, /name="mapping"/);
      assert.match(body, /email:0/);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ imported: 1 }));
    }, async (baseUrl) => {
      const client = createOutreachClient({ baseUrl, token: "dedicated-token" });
      const result = await client.upload("/api/outreach/imports", {
        filePath,
        fields: { mapping: "email:0" },
        allowedExtensions: [".csv", ".xlsx"],
        maxBytes: 1024,
      });
      assert.deepEqual(result, { imported: 1 });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("timeouts become safe OutreachApiError instances", async () => {
  await withServer(async (_request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    response.end("late");
  }, async (baseUrl) => {
    const client = createOutreachClient({ baseUrl, token: "dedicated-token", timeoutMs: 10 });
    await assert.rejects(
      client.get("/api/slow"),
      (error) => error instanceof OutreachApiError && error.code === "request_timeout" && !error.message.includes("dedicated-token"),
    );
  });
});

test("non-JSON HTTP failures are capped and never reveal the token", async () => {
  await withServer((_request, response) => {
    response.statusCode = 502;
    response.end(`upstream failed ${"x".repeat(2_000)}`);
  }, async (baseUrl) => {
    const client = createOutreachClient({ baseUrl, token: "dedicated-token" });
    await assert.rejects(client.get("/api/fail"), (error) => {
      assert.equal(error instanceof OutreachApiError, true);
      assert.equal(error.status, 502);
      assert.equal(error.code, "http_error");
      assert.ok(error.message.length < 700);
      assert.equal(error.message.includes("dedicated-token"), false);
      return true;
    });
  });
});

test("malformed or non-JSON success responses are rejected without echoing bodies", async () => {
  for (const response of [
    new Response('{"password":"secret-value"', { status: 200, headers: { "content-type": "application/json" } }),
    new Response("password=secret-value", { status: 200, headers: { "content-type": "text/plain" } }),
  ]) {
    const client = createOutreachClient({
      baseUrl: "http://127.0.0.1:3000",
      token: "mcp-secret",
      fetchImpl: async () => response,
    });
    await assert.rejects(() => client.get("/api/dashboard"), (error) => {
      assert.equal(error.code, "invalid_api_response");
      assert.equal(JSON.stringify(error).includes("secret-value"), false);
      return true;
    });
  }
});

test("response body read failures become bounded safe errors", async () => {
  const client = createOutreachClient({
    baseUrl: "http://127.0.0.1:3000",
    token: "mcp-secret",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => { throw new Error("password=secret-value"); },
    }),
  });
  await assert.rejects(() => client.get("/api/dashboard"), (error) => {
    assert.equal(error.code, "response_read_failed");
    assert.equal(error.message.includes("secret-value"), false);
    return true;
  });
});

test("client and upload validation reject unsafe inputs before fetch", async () => {
  assert.throws(() => createOutreachClient({ baseUrl: "file:///tmp/outreach", token: "token" }), /http/);
  assert.throws(() => createOutreachClient({ baseUrl: "http://127.0.0.1:3000", token: "" }), /token/i);

  const directory = await mkdtemp(path.join(os.tmpdir(), "outreach-mcp-validation-"));
  const csvPath = path.join(directory, "large.csv");
  const textPath = path.join(directory, "leads.txt");
  await writeFile(csvPath, "0123456789");
  await writeFile(textPath, "email");
  const client = createOutreachClient({
    baseUrl: "http://127.0.0.1:3000",
    token: "dedicated-token",
    fetchImpl: () => assert.fail("fetch must not run for invalid files"),
  });
  try {
    await assert.rejects(client.upload("/api/import", { filePath: "relative.csv" }), /absolute/i);
    await assert.rejects(client.upload("/api/import", { filePath: directory }), /regular file/i);
    await assert.rejects(client.upload("/api/import", { filePath: textPath, allowedExtensions: [".csv"] }), /extension/i);
    await assert.rejects(client.upload("/api/import", { filePath: csvPath, maxBytes: 5 }), /size/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
