# Deferred contacts for manual follow-up

The user wants deferred contacts retained for another pass and explicitly chose manual scheduling. Existing outcome records already persist `later`; there is currently no dedicated all-time worklist or return date.

Use a dedicated cabinet page “Вернуться позже” backed by these same records, without duplicating people or creating delivery jobs. It shows all deferred recipients in the selected campaign regardless of the Analytics cohort period, including stale later assessments that need another review. Each row includes contact/source, the recorded deferral reason, complete scoped conversation, optional owner-assigned return date and note. No date is assigned automatically. Undated contacts remain visible. Show undated, due (Moscow calendar date) and upcoming views/counts with stable pagination.

Add optional manual date/note columns to the outcome record. Only the owner UI can change them, using the current conversation snapshot and the existing owner/reply lock. This edit must not mark a semantic assessment manual or alter counts, message bodies, approvals, queue, pause or campaign revision. Agent reassessments preserve manual dates while the contact stays later. All semantic updates preserve owner scheduling fields. Another semantic status removes the contact from the active list; a later return to this status shows the retained manual date for another owner review. Declined/not-target/booked recipients do not become follow-up sends.

Expose a read-only scoped MCP follow-up list for the existing 09/18 agent. The agent can report/store due and unscheduled work, re-read actual imported conversation and prepare proposed text locally; it cannot set dates or automatically send follow-ups. Existing send confirmations, repetition limits and blockers remain in force. This request does not expand delivery capabilities.

Approach: extend the existing retained outcome record and add one derived worklist. A second contact database is unnecessary; a date-free later filter alone would not support the user's explicit manual scheduling choice. UI stays compact and uses the dashboard's established palette and table patterns. Backend defaults and migration leave every existing deferred contact undated.

Validation: real-DB classification/date isolation and preservation, invalid/stale/cross-owner writes, stable list/filter boundaries and Moscow due date; MCP read-only schemas; real browser date editor and responsive layout; repository checks; deployment and fresh actual contact read-back.
