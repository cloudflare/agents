---
"@cloudflare/ai-chat": patch
---

fix(ai-chat): serialize chat turns and expose turn control helpers

- queue `onChatMessage()` + `_reply()` work so user requests, tool continuations, and `saveMessages()` never stream concurrently
- make `saveMessages()` wait for the queued turn to finish before resolving, and reuse the request id for reply cleanup
- add protected `isChatTurnActive()`, `waitForIdle()`, and `abortActiveTurn()` helpers for subclass code that needs to inspect or control the active turn
