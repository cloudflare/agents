---
"agents": patch
"@cloudflare/ai-chat": patch
---

Clients and reconnecting tabs.

- `useAgent` and `AgentClient` connect to an Agent whose startup takes more than 4 seconds (the handshake timeout is now 15 s) and spread their reconnects after a restart. See [Client SDK](https://developers.cloudflare.com/agents/agent-class/communication-channels/chat/client-sdk/).
- A chat tab that joins a running reply gets live chunks again (#2703, #3068).
- A tab is told a request's end once, after a stop or a reconnect too (#3074, #3135, #3064).
- Connection state that is not a plain object keeps its shape (#2942).
