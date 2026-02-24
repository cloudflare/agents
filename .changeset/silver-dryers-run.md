---
"@cloudflare/ai-chat": patch
---

Moved `/get-messages` endpoint handling from a prototype `override onRequest()` method to a constructor wrapper. This ensures the endpoint always works, even when users override `onRequest` without calling `super.onRequest()`.
