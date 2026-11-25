---
"agents": patch
"@cloudflare/think": patch
---

Think retries an undelivered workflow notification as a Tasks run instead of a queue item plus scheduled retries; the backoff (2 s doubling, capped at ten minutes) and the twelve-hour give-up reported to `onError` are unchanged, and notifications queued by an earlier version are still delivered.
