---
"@cloudflare/ai-chat": minor
---

Add `durable` and `serverTurnCancellation` options to `useAgentChat`. `durable: true` treats browser/client stream cleanup as local-only while preserving explicit `stop()` as server-side turn cancellation.
