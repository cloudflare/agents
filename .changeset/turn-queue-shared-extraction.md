---
"agents": minor
"@cloudflare/think": patch
---

Add `TurnQueue` to `agents/chat` — a shared serial async queue with
generation-based invalidation for chat turn scheduling. AIChatAgent and
Think now both use `TurnQueue` internally, unifying turn serialization
and the epoch/clear-generation concept. Think gains proper turn
serialization (previously concurrent chat turns could interleave).
