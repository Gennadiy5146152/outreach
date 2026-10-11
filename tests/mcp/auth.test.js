import assert from "node:assert/strict";
import test from "node:test";
import { createAuth } from "../../src/http/auth.js";

const config = {
  authUser: "admin",
  authPassword: "browser-password",
  authSessionSecret: "session-secret-with-enough-entropy",
  authCookieSecure: false,
  mcpApiToken: "mcp-secret-token",
};

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    redirectedTo: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    redirect(path) {
      this.redirectedTo = path;
      return this;
    },
  };
}

function authorize(auth, request) {
  const response = responseRecorder();
  let nextCalls = 0;
  auth.requireAuth(request, response, () => {
    nextCalls += 1;
  });
  return { response, nextCalls };
}

test("a browser session cookie still authorizes protected pages", () => {
  const auth = createAuth({ ...config, now: () => 1_000 });
  const loginResponse = responseRecorder();
  auth.setAuthCookie(loginResponse);
  const cookie = loginResponse.headers["Set-Cookie"].split(";")[0];

  const result = authorize(auth, {
    path: "/api/leads",
    headers: { cookie, accept: "application/json" },
  });

  assert.equal(result.nextCalls, 1);
  assert.equal(result.response.statusCode, 200);
});

test("the dedicated bearer token authorizes protected API requests", () => {
  const auth = createAuth(config);
  const result = authorize(auth, {
    path: "/api/leads",
    headers: { authorization: "Bearer mcp-secret-token", accept: "application/json" },
  });

  assert.equal(result.nextCalls, 1);
  assert.equal(auth.isMcpAuthenticated({
    path: "/api/leads",
    headers: { authorization: "Bearer mcp-secret-token" },
  }), true);
});

test("invalid, missing, and unequal-length bearer tokens are rejected without throwing", () => {
  const auth = createAuth(config);
  for (const authorization of [undefined, "Bearer wrong", "Bearer mcp-secret-token-extra"]) {
    const headers = { accept: "application/json" };
    if (authorization) headers.authorization = authorization;
    const result = authorize(auth, { path: "/api/leads", headers });
    assert.equal(result.nextCalls, 0);
    assert.equal(result.response.statusCode, 401);
    assert.deepEqual(result.response.body, { error: "auth_required" });
  }
});

test("bearer authentication is never accepted for browser auth endpoints", () => {
  const auth = createAuth(config);
  for (const path of ["/api/auth/status", "/api/auth/login", "/api/auth/logout"]) {
    const request = {
      path,
      headers: { authorization: "Bearer mcp-secret-token", accept: "application/json" },
    };
    assert.equal(auth.isMcpAuthenticated(request), false);
    assert.equal(auth.isAuthenticated(request), false);
  }
});

test("bearer authentication is disabled when MCP_API_TOKEN is empty", () => {
  const auth = createAuth({ ...config, mcpApiToken: "" });
  const result = authorize(auth, {
    path: "/api/leads",
    headers: { authorization: "Bearer mcp-secret-token", accept: "application/json" },
  });

  assert.equal(result.nextCalls, 0);
  assert.equal(result.response.statusCode, 401);
});
