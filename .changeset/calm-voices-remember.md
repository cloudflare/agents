---
"@cloudflare/voice": patch
---

Define `VoiceTurnContext.messages` as completed history before the current transcript for both text and audio turns, preventing duplicate user messages when following the documented prompt construction.

Existing `onTurn()` implementations:

- If you pass `context.messages` directly as the complete LLM input, append `transcript` exactly once.
- If you already append `transcript` to `context.messages`, no change is required.
- Direct `getConversationHistory()` calls inside `onTurn()` continue to include the current transcript.
