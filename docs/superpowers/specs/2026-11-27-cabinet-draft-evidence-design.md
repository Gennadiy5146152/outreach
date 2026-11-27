# Cabinet draft evidence and paused campaign window

User approved moving six documented requests into the service after the proposed MCP changes. Goal: prepare ten selected drafts from Artem, within two hours, without sending before exact-plan approval.

Add optional source_url, permission_kind and permission_evidence to draft_update. Evidence and kind must be supplied together; valid kinds remain request/consent. Preserve recipient identity and body when omitted. Existing body-only clients continue to work. Ownership, campaign scope, account/token validity and no-dispatched-draft guards apply transactionally. All changes invalidate old launch previews through the existing draft snapshot.

Add a narrowly bounded campaign_window_update for an all-campaigns draft token or owner: change only HH:MM start/end of a paused campaign with no outstanding jobs on its connection. Keep the daily limit and paused state. Reject conflicting schedules of sibling campaigns and invalid/short windows. Increment revision and audit. This is editing an idle configuration, not launching delivery.

Approaches: direct SQL would bypass the API and is rejected. Recreating recipients would duplicate identity and is rejected. Extend the authenticated store/API/MCP path; no new account/session access, no wider scopes, no automatic sending. Folder automation was asked about separately and is outside this change.

Operational note: extending the idle morning window preserves its start and daily limit. Exact prepared slots must all fall in the next two hours; no unapproved execute and no folder mutations.
