# Execution plan
Spec: ../specs/2026-11-27-cabinet-draft-evidence-design.md

1. Add failing PostgreSQL/HTTP and MCP tests: partial draft edits preserve body/identity, validate paired evidence, enforce owner/scope/dispatched guards, invalidate an old launch. Add idle-window update tests for scope, paused/queue guard, conflicts and revision. Run and observe RED.
2. Implement store edit validation, ownerTransaction and bounded window method; route and strict MCP schemas. Run focused tests GREEN, full npm run check, test:cabinet and MCP tests, Python worker tests. No SQL edits in production.
3. Review the final diff independently, deploy via the normal GitHub flow, then use Artem token to transfer only six genuine dated request quotes and sources, read back all ten, recheck queue and history. Update idle window for the requested two-hour run, prepare exact ten and present full returned plan for explicit approval.

Review focus: token revocation races; cross-owner draft IDs; already-dispatched or uncertain jobs; partial permission edits; any modification of sender identity or send controls. Tests exercise each.
