---
"@cloudflare/voice": patch
---

Define `VoiceTurnContext.messages` as completed history before the current transcript for both text and audio turns, preventing duplicate user messages when following the documented prompt construction.

`onTurn()` implementations that previously passed `context.messages` directly as complete LLM input must now append `transcript` exactly once. The transcript is still persisted before `onTurn()` runs, so direct `getConversationHistory()` calls continue to include it.
