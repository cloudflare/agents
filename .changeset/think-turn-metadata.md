---
"@cloudflare/think": minor
---

Add `ChatOptions.metadata` — a per-turn, recovery-safe metadata carrier.

Server-side callers of `chat()` / `chatWithMessengerContext()` can now attach immutable per-turn metadata (e.g. "which authenticated principal initiated this turn"). It is stamped onto the turn's user message alongside `channel` (as `metadata.turnMetadata`) so a recovered/continued turn re-resolves it from durable history, and is readable turn-scoped via the new `Think.activeTurnMetadata` getter.

The trust model mirrors the channel stamp: the reserved metadata keys `channel` and `turnMetadata` are now stripped from client-supplied messages at intake, so a client can never forge server-written turn context (this also closes the prior gap where a client message could carry a forged `metadata.channel`). This lets messenger/RPC entry points carry correct multi-user identity without either mutable agent-wide state (a last-writer-wins race) or the submission path (which loses incremental streaming).
