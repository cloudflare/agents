---
"agents": patch
"@cloudflare/ai-chat": patch
---

Clients and reconnecting tabs.

- `useAgent` and `AgentClient` connect to an Agent whose startup takes more than 4 seconds (the handshake timeout is now 15 s) and spread their reconnects after a restart. See [Client SDK](https://developers.cloudflare.com/agents/agent-class/communication-channels/chat/client-sdk/).
- A chat tab that joins a running reply gets live chunks again (#2703, #3068).
- A tab is told a request's end once, after a stop or a reconnect too (#3074, #3135, #3064).
- Connection state that is not a plain object keeps its shape (#2942).
- After a reconnect, `useAgentChat` shows a turn the server accepted but has not started streaming as busy, and Stop cancels it (#2741).
- A client that reconnects to a sub-agent with its id before the old socket has closed gets its frames again: the sub-agent's sends, closes and state updates no longer fail while both sockets are open (#2709).
