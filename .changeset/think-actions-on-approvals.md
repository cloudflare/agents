---
"@cloudflare/think": patch
---

The action ledger now runs on the `Approvals` capability (`agents/approvals`). Rows in `cf_think_action_ledger` move to `cf_agents_effects` on the next start, so settled actions still replay.
