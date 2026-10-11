# Outreach MCP Design

## Purpose

Add a local MCP server to Outreach Desk so an assistant in Codex can prepare lead lists, manage drafts and campaigns, inspect delivery state, control follow-ups, process replies, and review analytics without bypassing the application's business rules.

The MCP server is an adapter for the existing Outreach Desk HTTP API. It does not query PostgreSQL directly, store mailbox passwords, or implement a second copy of sending logic.

## Success criteria

- Codex can complete the daily outreach workflow through domain-oriented MCP tools: inspect system state, prepare leads and drafts, run preflight, request approval, launch an exact batch, monitor it, and process replies.
- Real sends and other high-impact mutations cannot be executed through a single tool call. They require a prepared plan and a separate confirmed execution call.
- MCP traffic uses a dedicated token rather than the browser password or session cookie.
- Secrets are never returned in MCP tool results or written to stdout.
- List operations are filterable and paginated.
- The server is testable without sending email, and the end-to-end smoke path runs only in dry-run mode.

## Architecture

### MCP process

`src/mcp/server.js` is a local Node.js MCP server using the official v2 `@modelcontextprotocol/server` package and `stdio` transport. The project already uses ES modules and Node 22 in Docker; MCP requires Node 20 or newer.

The Codex host starts the process with `npm run mcp`. JSON-RPC is the only content written to stdout. Diagnostics go to stderr.

### HTTP client

`src/mcp/outreach-client.js` calls an Outreach Desk instance configured by `OUTREACH_BASE_URL`, defaulting to `http://127.0.0.1:3000`. Requests use `Authorization: Bearer <MCP_API_TOKEN>`, time out, decode JSON consistently, and convert application errors into safe MCP errors.

The MCP adapter calls existing `/api/*` endpoints so validation, transaction handling, event logging, queue semantics, and worker behavior remain authoritative in the application.

### API authentication

Outreach Desk accepts the dedicated bearer token for `/api/*` requests in addition to the existing browser session. The token comes from `MCP_API_TOKEN` and is compared with a timing-safe comparison. Browser login behavior remains unchanged.

Bearer authentication is rejected when `MCP_API_TOKEN` is unset. Authentication endpoints do not accept MCP bearer authentication. API responses available through MCP must not expose password environment values or raw secrets.

### Tool registration

`src/mcp/tools.js` registers domain-oriented tools and delegates to focused handler modules. Schemas use Zod v4. Similar operations in one domain may share an `action` enum where this keeps the catalog easier to use without hiding materially different side effects.

Every tool returns:

- a concise human-readable summary;
- structured data suitable for the next tool call;
- `next_actions` when a normal next step exists;
- `isError: true` with a safe message for expected failures.

## Tool surface

### System and analytics

- `outreach_status`: health, dry-run state, readiness, and safe runtime settings.
- `outreach_dashboard`: outreach-only metrics and funnel summary.
- `events_list`: recent audit events with pagination.
- `delivery_mode_prepare` and `delivery_mode_execute`: switch between dry-run and real delivery with confirmation when enabling real delivery.

### Leads and imports

- `leads_list`: filtered and paginated leads.
- `lead_upsert`: create or update one lead.
- `leads_import`: import a local CSV or XLSX file through the existing multipart API after validating the local path and size.

### Drafts and launch

- `drafts_list`: filtered drafts with concise previews.
- `draft_update`: recipient, subject, bodies, mailbox, schedule, and follow-up changes supported by the existing API.
- `drafts_preflight`: existing preflight results for an exact set of draft IDs.
- `draft_bulk_action_prepare` and `draft_bulk_action_execute`: cancel or delete an exact displayed set after confirmation.
- `attachment_upload`, `attachment_delete_prepare`, and `attachment_delete_execute`: manage existing campaign-step and outreach-step attachment endpoints using validated local paths.
- `launch_prepare`: validate either an exact draft set or one campaign plus its active enrollments and launch parameters, then create an expiring confirmation plan.
- `launch_execute`: consume the corresponding draft or campaign launch plan after explicit human approval.

### Campaigns and queue

- `campaigns_list`: campaigns and their operational state.
- `campaign_manage`: create or update a campaign, steps, and enrollment selection using explicit actions.
- `queue_list`: waiting, sent, or all queue items with pagination.
- `queue_approval_prepare` and `queue_approval_execute`: prepare and approve exact manual queue items.
- `queue_cancel`: cancel one exact queue item; bulk cancellation uses confirmation planning.

### Runs and conversations

- `runs_list` and `run_get`: launches, progress, recipients, and errors.
- `run_control`: prepare or execute stop/continue operations for a run.
- `conversations_list` and `conversation_get`: review queue, message history, classification, link quality, and next action.
- `conversation_classify`: update a classification.
- `conversation_action`: prepare or execute stop, continue, delay, close, thread assignment, or suppression-related actions.
- `reply_prepare` and `reply_execute`: preview and send one manual reply with confirmation.

### Suppressions and mailbox operations

- `suppressions_list`: safe list of suppressed emails and domains.
- `suppression_prepare` and `suppression_execute`: add an exact email or domain after confirmation.
- `mailboxes_list`: mailbox health and non-secret settings.
- `mailbox_check`: run existing SMTP, IMAP, and domain readiness checks without exposing credentials.
- `inbox_sync`: request synchronization and return its status.

Rare administrative settings and mailbox passwords remain web-only in the first release.

## Confirmation protocol

High-impact operations use a two-phase protocol:

1. A `*_prepare` tool calls the authoritative preflight/read endpoints and builds a canonical plan containing the operation, exact entity IDs, relevant revision fields, parameters, consequences, dry-run state, recipient counts, warnings, and expiry.
2. The MCP server stores the plan in memory and returns a random opaque `confirmation_token`, a human-readable summary, and `requires_confirmation: true`.
3. The assistant presents the summary and asks the user for explicit permission.
4. A separate `*_execute` tool requires the token and `confirm: true`.
5. Before mutation, execution re-reads the relevant state. If the canonical fingerprint differs, the plan is expired and a new preparation and approval are required.
6. A token is single-use, scoped to one MCP process, and expires after 10 minutes. It is invalidated on every execution attempt, including an application-level failure, to prevent ambiguous retries.

The protected operations are:

- launching drafts or campaigns that can lead to delivery;
- approving manual queue entries;
- sending a manual reply;
- enabling real delivery instead of dry-run;
- mass cancellation or deletion;
- adding email or domain suppressions;
- stopping or continuing an entire run when multiple recipients are affected.

A batch approval covers only the displayed recipients and displayed follow-up sequence. Any change requires a new plan. The MCP tool descriptions also state that execute tools may be called only after explicit human approval in the current conversation.

## File handling

Import and attachment tools accept absolute local paths. The adapter resolves the path, requires a regular file, enforces the application's current upload size limit, and permits only endpoint-supported extensions. File content is streamed as multipart data and is never embedded in tool results.

The first release supports lead/import files. Mailbox passwords remain web-only. Attachment support is included only where the existing HTTP endpoint already provides a safe, unambiguous target ID.

## Error handling and redaction

- Network connection failures state which base URL was unavailable and suggest starting Outreach Desk.
- Non-2xx API responses preserve the application error code and safe validation details.
- Timeouts and malformed JSON become bounded MCP errors rather than process crashes.
- Headers, bearer tokens, cookies, password environment keys, database URLs, and raw stack traces are redacted.
- List responses have conservative defaults and maximum page sizes.
- The MCP process handles shutdown without writing non-protocol data to stdout.

## Configuration and operation

New environment values:

- `MCP_API_TOKEN`: required by both Outreach Desk and the MCP process.
- `OUTREACH_BASE_URL`: optional MCP-side URL; defaults to `http://127.0.0.1:3000`.
- `MCP_CONFIRMATION_TTL_SECONDS`: optional; defaults to `600` and is bounded to a safe range.
- `MCP_REQUEST_TIMEOUT_MS`: optional; defaults to `15000`.

`npm run mcp` starts the stdio server. README documentation includes a Codex MCP configuration example that uses an absolute project path and environment variables without committing secrets.

## Testing

Tests follow test-driven development and never deliver real email.

- HTTP client tests use a local fake HTTP server and cover authorization, query encoding, multipart uploads, timeouts, non-JSON errors, and redaction.
- Confirmation-store tests cover canonical fingerprints, expiry, single use, wrong operation, changed state, and failure invalidation.
- Tool tests use an injected fake client and assert schemas, endpoint mapping, pagination caps, summaries, structured results, and protected execution.
- Authentication tests prove that valid bearer access reaches protected APIs, missing or invalid tokens fail, auth endpoints remain browser-only, and existing cookie auth still works.
- A stdio/client integration test initializes the server, lists tools, calls a read tool against a fake API, and verifies stdout protocol integrity.
- A documented smoke test can target a running Outreach Desk only when its runtime reports `dryRun: true`.
- The existing `npm run check` suite must remain green.

## Non-goals for the first release

- Direct PostgreSQL access from MCP.
- Remote HTTP hosting of the MCP server.
- Storing mailbox passwords or browser credentials in MCP configuration.
- Bypassing existing preflight, queue, suppression, or worker rules.
- Creating a second worker or sending SMTP directly from MCP.
- Exposing every internal HTTP route one-for-one.
