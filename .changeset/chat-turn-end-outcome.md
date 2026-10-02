---
"agents": patch
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

`useAgentChat` gains `onTurnEnd`, and terminal chat frames carry outcomes and user message IDs so clients can settle sends correctly across recovery and reconnects. Replay, tool callbacks, and turn state now remain consistent through terminal delivery; see [Chat agents](https://github.com/cloudflare/agents/blob/main/docs/agents/chat-agents.md).
