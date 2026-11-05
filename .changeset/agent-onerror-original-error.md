---
"agents": patch
"@cloudflare/ai-chat": patch
---

When `onError` returns instead of throwing, `Agent` and `AIChatAgent` now pass the original error on, instead of `undefined` (or an unawaited promise when `onError` is async).
