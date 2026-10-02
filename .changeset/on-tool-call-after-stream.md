---
"agents": patch
---

`useAgentChat` calls `onToolCall` only after the stream ends, and only for tool calls still waiting on the client (#2195). See [Client tools](https://github.com/cloudflare/agents/blob/main/docs/agents/client-tools-continuation.md).
