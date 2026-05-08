---
"@cloudflare/ai-chat": patch
---

Close the original WebSocket chat transport stream when the socket disconnects before a terminal response, preventing recovered chat continuations from leaving `useAgentChat` stuck in streaming state.
