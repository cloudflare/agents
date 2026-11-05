---
"agents": patch
---

When an `Agent`'s `onError` returns instead of throwing, the original error now continues to Lifecycle, instead of `undefined` (or an unawaited promise when `onError` is async).
