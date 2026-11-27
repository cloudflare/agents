---
"agents": patch
"@cloudflare/ai-chat": patch
---

Clients.

- `useAgent` and `AgentClient` wait up to 15 s for the handshake (was 4 s) and spread their reconnects.
- A tab joining a running reply gets live chunks, and each request's end once, also after a stop or reconnect (#2703, #3068, #3074, #3135, #3064).
- After a reconnect, `useAgentChat` shows an accepted turn as busy, and Stop cancels it (#2741).
- A client reconnecting to a sub-agent before its old socket closed gets frames (#2709).
