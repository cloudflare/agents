---
"@cloudflare/ai-chat": minor
---

Add `cancelOnClientAbort` to `useAgentChat`. Generic browser/client stream cleanup is now local-only by default so server turns can continue and resume; explicit `stop()` still cancels the server turn. Set `cancelOnClientAbort: true` to make generic client aborts cancel the server turn.
