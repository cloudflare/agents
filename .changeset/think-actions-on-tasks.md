---
"@cloudflare/think": patch
---

Action idempotency records and durable-pause approvals are now stored as task runs; existing records and parked approvals move forward on first start, and the action and approval APIs are unchanged.
