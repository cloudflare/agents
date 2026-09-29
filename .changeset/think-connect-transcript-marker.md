---
"@cloudflare/think": patch
---

Mark the transcript Think sends to a newly connected client with `connect: true`, so `useAgentChat` keeps a message the user sent while disconnected instead of erasing it on reconnect (#1983).
