# Manual deferred-contact worklist plan

> Use superpowers:executing-plans to implement and verify this approved user-requested extension. Date policy was explicitly chosen by the user: manual only.

1. Add nullable manual scheduling fields and a scoped derived follow-up list; owner-only date update with snapshot checks. Write and run real-DB regressions before implementation.
2. Expose only read capability through MCP. Add a separate compact cabinet page and date editor using current UI patterns, and include the browser module in public account routes. Verify real-browser behavior.
3. Run checks and focused independent review, deploy, update protected runtime and existing agent instructions, seed no dates, verify the retained actual deferred contact.

No new client messages, delivery jobs or automatic dates are authorized by this change. Preserve unrelated canonical edits.

## Implementation verification

Repository checks passed; 104 disposable-PostgreSQL cabinet/MCP tests and 53 worker tests passed. Existing analytics and new deferred-page browser regressions passed. Owner-cookie local preview verified the actual date PATCH, clearing back to NULL and unchanged semantic source. Desktop/mobile screenshots inspected; mobile actions are visible without horizontal scrolling. Independent review found a delayed-save/editor replacement race; a RED/GREEN browser regression now preserves the newer editor and its inputs.
