---
"@cloudflare/think": patch
"agents": patch
---

`Think` retries a workflow notification with backoff for up to twelve hours after its first attempt, then reports it to `onError`. Notifications pending from earlier releases are delivered the same way.
