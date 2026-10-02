---
"agents": patch
---

`AiSdkHarness` no longer fails to start when it has stored sessions. `onStart` listed sessions while listing each one's pending work, and Durable Object storage allows one open `kv.list()` at a time, so a restarted agent stopped acknowledging messages.
