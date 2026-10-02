---
"agents": patch
---

`useAgent` and `AgentClient` resolve `ready` only after the agent's state arrives, so `state` is no longer briefly `undefined` (#2268). See [Client SDK](https://github.com/cloudflare/agents/blob/main/docs/agents/client-sdk.md).
