---
"agents": patch
---

`useAgent` and `AgentClient` now connect to an Agent whose startup or `onConnect` takes more than 4 seconds (the handshake timeout defaults to 15 s), and spread their reconnects after a restart with a first retry delay picked per client between 1 and 5 s. See [Client SDK](https://developers.cloudflare.com/agents/agent-class/communication-channels/chat/client-sdk/).
