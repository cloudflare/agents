---
"@cloudflare/think": patch
---

Internal refactor of the action ledger, no API change. Rows in `cf_think_action_ledger` move to a new table on the next start, so settled actions still replay.
