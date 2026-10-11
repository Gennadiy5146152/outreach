# Outreach MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe local MCP server that exposes Outreach Desk's daily outreach workflows through its existing HTTP API, with mandatory two-phase confirmation before delivery or other high-impact mutations.

**Architecture:** A Node.js stdio MCP adapter registers domain-oriented tools backed by a small authenticated HTTP client. Existing Express routes remain authoritative. An in-memory confirmation store binds prepared plans to canonical snapshots, expiry, and single-use execution.

**Tech Stack:** Node.js 20+, ES modules, official `@modelcontextprotocol/server` v2, Zod v4, native `fetch`/`FormData`, Node test runner, Express.

**Spec:** `docs/superpowers/specs/2026-10-11-outreach-mcp-design.md`

## Global Constraints

- MCP must never query PostgreSQL or send SMTP directly.
- MCP logs only to stderr; stdout is reserved for the stdio protocol.
- `MCP_API_TOKEN` is required for bearer access and must never appear in responses or logs.
- `OUTREACH_BASE_URL` defaults to `http://127.0.0.1:3000`.
- Confirmation tokens are random, single-use, process-local, expire after 600 seconds by default, and are invalidated on every execution attempt.
- Real sends, manual replies, queue approval, delivery-mode changes, bulk destructive actions, suppression additions, and multi-recipient run control require prepare then execute with `confirm: true`.
- Existing behavior and `npm run check` must remain green; live smoke checks are dry-run only.

## Review Focus

- A valid browser cookie must continue to authorize UI requests after bearer authentication is added; cover in Task 1.
- A bearer token must never authorize `/api/auth/login`, `/api/auth/logout`, or `/api/auth/status`; cover in Task 1.
- A timed-out or non-JSON API response must become a bounded redacted MCP error; cover in Task 2.
- A confirmation token must not execute when the current canonical snapshot differs only by reordered object keys; stable canonicalization must distinguish semantic changes but ignore key order; cover in Task 3.
- An execute attempt that fails downstream must still consume its token, preventing ambiguous retries; cover in Task 5.

---

### Task 1: Dedicated MCP bearer authentication

**Files:**
- Create: `src/http/auth.js`
- Modify: `src/config/env.js`
- Modify: `src/server.js`
- Modify: `.env.example`
- Test: `tests/mcp/auth.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `createAuth({ authUser, authPassword, authSessionSecret, authCookieSecure, mcpApiToken, now? })` returning `authConfigured`, `isAuthenticated`, `setAuthCookie`, `clearAuthCookie`, and `requireAuth`.
- Produces: `env.mcpApiToken: string`.

- [ ] **Step 1: Add failing auth tests**

Test cookie authorization, valid bearer authorization for a protected `/api/*` request, invalid/missing bearer rejection, bearer rejection on `/api/auth/*`, and timing-safe behavior for unequal token lengths. Update `test:mcp` to run `node --test tests/mcp/*.test.js`.

- [ ] **Step 2: Run auth tests and verify RED**

Run: `npm run test:mcp`
Expected: FAIL because `src/http/auth.js` and the script do not exist.

- [ ] **Step 3: Extract existing cookie auth and add scoped bearer auth**

Implement `createAuth`, wire it into `src/server.js`, add `MCP_API_TOKEN` to env configuration and `.env.example`, and preserve public-path behavior and current login routes.

- [ ] **Step 4: Run auth tests and existing auth regression**

Run: `npm run test:mcp && node tests/test-auth-static.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json src/http/auth.js src/config/env.js src/server.js .env.example tests/mcp/auth.test.js
git commit -m "feat: add MCP API authentication"
```

### Task 2: Safe Outreach HTTP client

**Files:**
- Create: `src/mcp/errors.js`
- Create: `src/mcp/outreach-client.js`
- Test: `tests/mcp/outreach-client.test.js`

**Interfaces:**
- Produces: `class OutreachApiError extends Error { status, code, details }` with a redacted message.
- Produces: `createOutreachClient({ baseUrl, token, timeoutMs?, fetchImpl? })` returning `request`, `get`, `post`, `patch`, `put`, `delete`, and `upload`.
- `upload(path, { filePath, fields?, allowedExtensions?, maxBytes? })` validates an absolute regular-file path and sends multipart data.

- [ ] **Step 1: Add failing HTTP client tests**

Use a local Node HTTP server to assert bearer headers, query encoding, JSON bodies, multipart filename/fields, timeout behavior, safe non-JSON errors, base-URL validation, extension/size/path rejection, and secret redaction.

- [ ] **Step 2: Run the client test and verify RED**

Run: `node --test tests/mcp/outreach-client.test.js`
Expected: FAIL because the client module does not exist.

- [ ] **Step 3: Implement the minimal client and errors**

Use native `fetch`, `AbortSignal.timeout`, `FormData`, and `fs.openAsBlob`. Cap response error details and never attach request headers or token values to errors.

- [ ] **Step 4: Run client tests**

Run: `node --test tests/mcp/outreach-client.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/errors.js src/mcp/outreach-client.js tests/mcp/outreach-client.test.js
git commit -m "feat: add safe outreach API client"
```

### Task 3: Confirmation-plan store

**Files:**
- Create: `src/mcp/confirmation-store.js`
- Test: `tests/mcp/confirmation-store.test.js`

**Interfaces:**
- Produces: `stableStringify(value)` and `fingerprint(value)`.
- Produces: `createConfirmationStore({ ttlSeconds = 600, now?, randomUUID? })` with `prepare({ operation, payload, snapshot, summary })` and `consume({ token, operation, currentSnapshot, confirm })`.
- `consume` returns the stored plan only once; it invalidates before validating downstream state.

- [ ] **Step 1: Add failing confirmation tests**

Cover successful consume, `confirm !== true`, expiry, wrong operation, unknown token, single use, stable object-key ordering, semantic snapshot change, payload binding, and invalidation after a failed validation attempt.

- [ ] **Step 2: Run the confirmation test and verify RED**

Run: `node --test tests/mcp/confirmation-store.test.js`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the confirmation store**

Use SHA-256 for canonical fingerprints and opaque UUID tokens. Bound TTL to 60–3600 seconds.

- [ ] **Step 4: Run confirmation tests**

Run: `node --test tests/mcp/confirmation-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/confirmation-store.js tests/mcp/confirmation-store.test.js
git commit -m "feat: add MCP confirmation plans"
```

### Task 4: Domain tool catalog and read/write handlers

**Files:**
- Create: `src/mcp/result.js`
- Create: `src/mcp/tool-definitions.js`
- Create: `src/mcp/tool-handlers.js`
- Test: `tests/mcp/tool-handlers.test.js`

**Interfaces:**
- Produces: `TOOL_DEFINITIONS`, an array of `{ name, description, inputSchema, annotations }`.
- Produces: `createToolHandlers({ client, confirmations })`, a map from tool name to async handler.
- Produces: result helpers returning both text content and `structuredContent` with `summary`, `data`, and `next_actions`.

- [ ] **Step 1: Add failing handler tests for safe read and ordinary write tools**

Assert endpoint/method/body mapping and pagination caps for status, dashboard, events, leads, drafts, campaigns, queue, runs, conversations, suppressions, and mailboxes. Assert mappings for lead upsert, import, draft update/step update, attachment upload, campaign actions, classification, mailbox check, and inbox sync. Assert no returned object exposes keys matching token, password, cookie, authorization, secret, database URL, or raw headers.

- [ ] **Step 2: Run handler tests and verify RED**

Run: `node --test tests/mcp/tool-handlers.test.js`
Expected: FAIL because the tool modules do not exist.

- [ ] **Step 3: Implement result redaction, definitions, and ordinary handlers**

Implement the spec's catalog with bounded Zod schemas and endpoint maps. Keep high-impact execute behavior unimplemented until Task 5; prepare handlers may create plans.

- [ ] **Step 4: Run handler tests**

Run: `node --test tests/mcp/tool-handlers.test.js`
Expected: PASS for safe reads and ordinary writes.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/result.js src/mcp/tool-definitions.js src/mcp/tool-handlers.js tests/mcp/tool-handlers.test.js
git commit -m "feat: expose outreach domain tools"
```

### Task 5: Protected prepare/execute workflows

**Files:**
- Modify: `src/mcp/tool-handlers.js`
- Modify: `src/mcp/tool-definitions.js`
- Test: `tests/mcp/protected-tools.test.js`

**Interfaces:**
- Consumes: confirmation-store `prepare` and `consume` from Task 3.
- Produces: working pairs for `launch_*`, `queue_approval_*`, `reply_*`, `suppression_*`, `delivery_mode_*`, `draft_bulk_action_*`, and `attachment_delete_*`; protected branches of `run_control` and `conversation_action` use the same plan protocol.

- [ ] **Step 1: Add failing protected-workflow tests**

For draft and campaign launch, queue approval, manual reply, suppression, enabling real delivery, draft bulk actions, attachment deletion, run stop/continue, and destructive conversation actions, assert prepare reads authoritative state and execute re-reads it before mutation. Assert no mutation on missing approval, changed snapshot, expired/wrong token, or failed preflight. Assert a downstream HTTP failure still consumes the token.

- [ ] **Step 2: Run protected tests and verify RED**

Run: `node --test tests/mcp/protected-tools.test.js`
Expected: FAIL because execute handlers are unavailable.

- [ ] **Step 3: Implement protected handlers**

Bind plans to exact source IDs, modes, schedules, reply content, suppression target, and consequence summary. Mark execute tools with destructive/idempotency annotations as appropriate and state the explicit-human-approval rule in each description.

- [ ] **Step 4: Run all MCP unit tests**

Run: `npm run test:mcp`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tool-handlers.js src/mcp/tool-definitions.js tests/mcp/protected-tools.test.js
git commit -m "feat: protect outreach mutations with confirmation"
```

### Task 6: MCP server, stdio integration, and operator documentation

**Files:**
- Create: `src/mcp/create-server.js`
- Create: `src/mcp/server.js`
- Create: `tests/mcp/server-integration.test.js`
- Modify: `src/config/env.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`

**Interfaces:**
- Produces: `createOutreachMcpServer({ client?, confirmations? }) -> McpServer`.
- Produces: `npm run mcp` and `npm run test:mcp`.
- The executable entry uses `serveStdio(() => createOutreachMcpServer())` and logs readiness only to stderr.

- [ ] **Step 1: Add the official SDK dependencies and failing integration test**

Install production dependencies `@modelcontextprotocol/server@^2.3.1` and `zod@^4.6.6`, plus matching `@modelcontextprotocol/client@^2.3.1` as a dev dependency. Use the official in-memory client transport to initialize, list tools, call `outreach_status` against a fake client, inspect structured output, and close cleanly.

- [ ] **Step 2: Run the integration test and verify RED**

Run: `node --test tests/mcp/server-integration.test.js`
Expected: FAIL because server factory and entry point do not exist.

- [ ] **Step 3: Implement server factory and stdio entry**

Register every definition with its matching handler, use configured base URL/token/timeout/TTL, fail fast on missing `MCP_API_TOKEN`, and keep stdout protocol-only.

- [ ] **Step 4: Document setup and dry-run smoke workflow**

Document environment variables, absolute-path Codex MCP configuration, `npm run mcp`, Inspector usage, the confirmation contract, safe dry-run verification, and the fact that mailbox passwords remain web-only.

- [ ] **Step 5: Run complete verification**

Run: `npm run test:mcp && npm run check && node --check src/mcp/server.js && git diff --check`
Expected: all commands PASS with no warnings from project code.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/mcp tests/mcp README.md
git commit -m "feat: add Outreach Desk MCP server"
```
