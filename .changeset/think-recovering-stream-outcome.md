---
"@cloudflare/think": patch
---

Record the close outcome on Think's chat streams, so a resume that replays a stream closed for a scheduled recovery reports `recovering` (and an aborted stream reports `aborted`) instead of `completed`.
