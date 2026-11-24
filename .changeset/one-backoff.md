---
"agents": patch
"@cloudflare/think": patch
---

Retry delays for a fiber's failing recovery hook, chat recovery after a transient provider error, Tasks steps with `backoff: "exponential"`, and Think's workflow-notification and messenger-reply retries are now jittered (between half and all of the previous delay), so work that failed together does not retry together.
