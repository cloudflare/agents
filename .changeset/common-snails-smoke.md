---
"agents": patch
---

A WebSocket close before the final `done` frame now puts `useAgentChat` in the `error` state instead of showing a truncated answer as complete (#2013). See [Chat agents](https://github.com/cloudflare/agents/blob/main/docs/agents/chat-agents.md).
