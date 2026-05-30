---
"@cloudflare/think": patch
---

Settled tool results are now flushed to durable storage immediately during a
chat turn, so recovery never re-runs an already-completed (often non-idempotent)
tool call. Stream chunks are batched in memory and flushed to SQLite every ~10
chunks; the WebSocket chat path did not force a flush on settled tool results,
so an isolate eviction (deploy) before the next batch flush lost them. Recovery
then rebuilt the partial assistant message without those tool calls and the
model re-ran them (e.g. duplicate INSERTs). The sub-agent RPC streaming path
already flushed recoverable content; this brings the WebSocket path to parity
via a shared `_storeChunkDurably` helper that flushes immediately on
`tool-output-available` / `tool-output-error`. Net effect: recovery loses at
most the single in-flight step, even when multiple evictions hit one turn.

Also closes two remaining "frozen turn" hydration gaps from the terminal-status
work: a turn that fails before the stream starts (e.g. a message reconciliation
error in `_handleChatRequest`) now records its terminal status, and a recovery
skip caused by `onChatRecovery` returning `{ continue: false }` now surfaces a
terminal error too. Both were previously broadcast (or silent) but not persisted,
so a client disconnected at that moment stayed frozen on reconnect. Benign skips
such as `conversation_changed` (a newer turn already owns the UI) remain silent.
