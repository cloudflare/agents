---
"@cloudflare/think": minor
"@cloudflare/ai-chat": patch
"agents": patch
---

Wire Session into Think as the storage layer, achieving full feature parity with AIChatAgent plus Session-backed advantages.

**Think (`@cloudflare/think`):**

- Session integration: `this.messages` backed by `session.getHistory()`, tree-structured messages, context blocks, compaction, FTS5 search
- `configureSession()` override for context blocks, compaction, search, skills (sync or async)
- `assembleContext()` returns `{ system, messages }` with context block composition
- `onChatResponse()` lifecycle hook fires from all turn paths
- Non-destructive regeneration via `trigger: "regenerate-message"` with Session branching
- `saveMessages()` for programmatic turn entry (scheduled responses, webhooks, proactive agents)
- `continueLastTurn()` for extending the last assistant response
- Custom body persistence across hibernation
- `sanitizeMessageForPersistence()` hook for PII redaction
- `messageConcurrency` strategies (queue/latest/merge/drop/debounce)
- `resetTurnState()` extracted as protected method
- `unstable_chatRecovery` with `runFiber` wrapping on all 4 turn paths
- `onChatRecovery()` hook with `ChatRecoveryContext`
- `hasPendingInteraction()` / `waitUntilStable()` for quiescence detection
- Re-export `Session` from `@cloudflare/think`
- Constructor wraps `onStart` — subclasses never need `super.onStart()`

**agents (`agents/chat`):**

- Extract `AbortRegistry`, `applyToolUpdate` + builders, `parseProtocolMessage` into shared `agents/chat` layer
- Add `applyChunkToParts` export for fiber recovery

**AIChatAgent (`@cloudflare/ai-chat`):**

- Refactor to use shared `AbortRegistry` from `agents/chat`
- Add `continuation` flag to `OnChatMessageOptions`
- Export `getAgentMessages()` and tool part helpers
- Add `getHttpUrl()` to `useAgent` return value
