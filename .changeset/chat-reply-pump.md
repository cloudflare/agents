---
"@cloudflare/ai-chat": patch
"agents": patch
---

`AIChatAgent` replies: a completed reply's terminal frame carries `outcome`, a continuation's chunk frames name the message they go into, a stall emits `chat:stream:stalled`, a failed reply emits `chat:request:failed`, and a reply whose store fails runs `onChatResponse` with `error`. See [the decisions](https://github.com/cloudflare/agents/blob/main/design/chat-turn-core.md).
