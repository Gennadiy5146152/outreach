# Company Research Personalization Design

**Status:** approved for implementation on 2026-10-14 by the user's instruction to start immediately.

**Supersedes:** the hard industry and company-size exclusions in `2026-10-13-lead-personalization-design.md`. Existing website enrichment remains useful, but the new research queue covers every otherwise eligible company.

## Goal

Turn each company in the lead database into an evidence-backed research card that can support two distinct outreach drafts: a neutral message to the public company mailbox and, when a separate confirmed professional email exists, a role-specific message to a decision maker.

Research and draft preparation must never start delivery. All existing launch confirmation, quota, suppression, reply-stop, and company-level stop controls remain authoritative.

## Scope

The first release provides:

- a prioritized research queue for all eligible companies;
- MCP tools for an external agent to claim a company, store public sources, facts, and contacts, and finish or fail the job;
- evidence validation, URL safety, contact deduplication, and a maximum of ten sources per company;
- research-card API and UI inside the existing Personalization section;
- separate general and executive draft candidates stored against one company/lead, with no guessed addresses;
- prepare/execute confirmation for bulk queue creation and bulk draft materialization;
- tests proving that research cannot enqueue or send mail.

The service does not crawl the open web itself and does not require a paid search API. An agent performs public web research and writes structured evidence through MCP. A future search provider may use the same job contract.

## Eligibility and priority

Industry and company size affect order, not inclusion. The default priority is:

1. micro, small, and medium businesses;
2. factories and manufacturers of any size;
3. other large commercial businesses;
4. banks and government organizations.

Because the current lead schema does not contain a reliable company-size field, the first version derives a deterministic tier from segment/company text and records the reason. Unknown companies fall into the third tier. A company is excluded only for operational reasons: invalid or suppressed address, active conversation, duplicate company/domain, missing usable company identity, or an explicit legal/manual block.

Queue formation deduplicates by normalized website domain, falling back to normalized company plus email domain. Re-running queue creation is idempotent for the same rules version.

## Architecture and data flow

1. `prepare` returns the exact eligible company snapshot, counts per priority, and a hash.
2. After explicit approval, `execute` creates one research run per deduplicated company and marks it `queued`.
3. An MCP research agent claims the next run ordered by priority and age. Claiming uses a lease so abandoned work can be reclaimed.
4. The agent searches public sources and submits sources, facts, and contacts in bounded batches.
5. The service validates URLs, evidence, email ownership, source limits, and job lease before storing anything.
6. The agent completes the run as `review`, `ready`, or `failed`. `ready` requires at least one accepted fact and a general recipient; a personal recipient is optional.
7. The UI presents the company card, evidence, contact candidates, and potential drafts.
8. A separate prepare/execute operation materializes selected draft candidates into ordinary Outreach drafts. This still does not launch them.

## Data model

### `company_research_runs`

One row per company key and rules version. Fields include lead, company key, status (`queued`, `researching`, `review`, `ready`, `failed`), priority tier/reason, lease owner/expiry, attempt count, last error, and timestamps. A uniqueness constraint on `(company_key, rules_version)` makes queue creation retry-safe.

### `company_research_sources`

Canonical public URL, source type, title, publisher, publication date, short excerpt (maximum 500 characters), trust tier, and metadata. A run may have at most ten sources and cannot store the same canonical URL twice.

### `company_research_facts`

A short fact linked to a stored source, with fact type, evidence excerpt, confidence, and `selected_for_copy`. Facts without a source are rejected.

### `company_contacts`

Contact name, role, optional email, email status (`confirmed`, `needs_review`, `rejected`), confidence, source, and evidence. Email is confirmed only when the public source explicitly associates that exact address with the company or person. Address-pattern guessing is prohibited. Normalized email is unique inside a company research run.

### `company_research_drafts`

Draft candidates belong to a research run and an audience key: `general` or `executive:<contact-id>`. They store recipient, subject, first message, and follow-up. Unique audience keys prevent duplicate candidates. If the executive email equals the general email, no executive candidate is created.

These candidates are not `outreach_drafts` and cannot be sent. Materialization into the existing draft system is a separate confirmed operation.

## Sources and evidence

Trust order:

1. official company website, official documents, and official accounts;
2. conference programs, event presentations, and speaker pages;
3. company publications and attributed interviews;
4. professional profiles and reputable directories;
5. public video pages and accessible subtitles.

Only public sources are permitted. Private groups, closed communities, leaked data, purchased lists, personal correspondence, and authentication bypasses are prohibited. For videos, store the link, optional timecode, and a short excerpt only. Never store a full transcript or page body.

External page text is untrusted data. The agent and service ignore embedded instructions, never execute page content, and store only normalized structured fields. URLs must be HTTP(S), contain no credentials, and pass the existing public-address/SSRF policy. Redirect targets are revalidated by any future fetcher.

## Contact and copy policy

The general draft uses the existing eligible company mailbox and a neutral greeting. It may mention the company/site and one grounded public fact.

The executive draft is generated only for a distinct confirmed public professional email. It may use the confirmed name, role, and one or two relevant facts. If only a name or role is found, it is shown for manual review and never addressed by a guessed email.

Personalization must sound natural and businesslike. It must not describe surveillance or say that the sender watched/read a specific person unless that citation is genuinely relevant and phrased neutrally.

Both candidates use the approved backup offer: organizing distributed backup storage under the 3-2-1 principle and the short follow-up asking whether the proposal is relevant. Unsupported claims, invented names, invented infrastructure details, and ambiguous pricing are blocked.

## User interface

The Personalization page gains a Company Research area with:

- queue summary and priority counts;
- state filters for queued, researching, review, ready, and failed;
- company, priority reason, general email, leaders/contacts, sources, selected facts, and errors;
- clearly separated general and executive draft candidates;
- retry and review controls;
- explicit statements that research and draft preparation do not send mail.

## MCP contract and confirmation

Read/scoped tools:

- list and inspect research runs;
- claim the next queued job;
- save bounded sources, facts, and contacts for the claimed job;
- complete or fail a claimed job;
- release an abandoned claim.

Protected tools:

- `company_research_queue_prepare` / `company_research_queue_execute` for batch queue creation;
- `company_research_drafts_prepare` / `company_research_drafts_execute` for materializing selected candidates.

Each prepare operation binds an exact server snapshot to a short-lived confirmation token. Execute requires fresh explicit approval and rejects changed state. Existing launch tools remain a third independent approval boundary before any delivery.

## Delivery isolation and company scope

Research code and MCP handlers must not write to `sending_queue`, `enrollments`, or `messages`, start the mail worker, or call mail services. Draft materialization may write only ordinary draft/import tables.

General and executive contacts share one company scope. Any reply, unsubscribe, bounce, suppression, or manual stop for one contact applies to all contacts at the same company through the existing company-stop policy. Both drafts may exist, but neither is auto-enrolled or auto-launched; the operator explicitly chooses recipients and timing in the normal launch preflight.

## Failure, retry, and idempotency

Claims use an expiring lease and compare the claimant ID on writes. Repeated source/contact writes upsert by canonical identity. Source eleven is rejected. Completion is retry-safe. A failed run keeps already accepted evidence and can be requeued. Conflicting identities or evidence produce `review`, not an invented resolution.

## Acceptance criteria

- Queue preview covers all eligible companies and uses priority only for ordering.
- Banks and government leads are not hard-excluded solely by segment.
- Company/domain duplicates create one research run.
- No run accepts more than ten sources or a source without a public safe URL.
- Every fact and confirmed contact points to stored evidence.
- Guessed emails are rejected; equal general/executive addresses do not create two candidates.
- General and executive candidates are distinct entities under one company.
- Research MCP code has no mail-delivery path.
- Queue creation and candidate materialization require prepare plus fresh explicit execute approval.
- The UI exposes status, priority, evidence, contacts, and both candidate types without rendering untrusted HTML.
- Migration, unit, MCP, UI, and full regression suites pass before deployment.

