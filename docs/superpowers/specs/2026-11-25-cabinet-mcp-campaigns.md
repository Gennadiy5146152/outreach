# Campaign creation through private-cabinet MCP

User approved adding campaign creation without the owner's password on 25 November 2026. Keep existing scopes: only `outreach:draft` tokens with `all_campaigns=true` may create campaigns inside their own cabinet. Selected-campaign tokens retain current restrictions. Owner-browser behavior remains compatible.

Expose `campaign_connections_list` with only connection ID, label, username/expected username and connection status, to select an existing sender. Keep QR, passwords, Telegram user/session data and connection mutations owner-only. Add `campaign_create` using the existing schedule/name/connection validation and audit transaction. It creates an empty paused campaign and no jobs. Every foreign connection is rejected by owner ID on the server.

Use the existing read/draft/send token for Artem, create a campaign with 10 messages/day and 09:30–11:30 Moscow settings, then save the reviewed334 messages as drafts. Do not invent request/consent evidence and do not execute sending. Creation is an ordinary reversible draft setup action already approved by the user.
