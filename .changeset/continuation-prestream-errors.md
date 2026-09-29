---
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

Report continuation turns that fail before they stream (#2381). When an auto-continuation (after a tool approval or a client tool result) or a connection-less continuation throws before producing a response, for example from `beforeTurn` or `onChatMessage`, clients now receive an error frame for the continuation and `onChatResponse` fires with `status: "error"` and `continuation: true`. The failure is also recorded as the terminal status, so a client that reconnects learns the turn failed. Think additionally calls `onChatError` with `stage: "turn"` and a new `continuation: true` field on `ChatErrorContext`, and emits `chat:request:failed`. Previously the failure was only logged, and the conversation looked like it was still waiting.
