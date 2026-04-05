---
"@cloudflare/ai-chat": minor
---

Rename `durableStreaming` to `unstable_chatRecovery`. Fix abort controller leak when `onChatMessage` throws. Wrap all 4 chat turn paths (WS, auto-continuation, programmatic, continueLastTurn) in `runFiber` when enabled. Guard `_chatRecoveryContinue` against stale continuations via `targetAssistantId` in schedule payload.
