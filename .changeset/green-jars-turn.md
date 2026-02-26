---
"agents": minor
"@cloudflare/ai-chat": patch
---

Add hook-style runtime context lifecycle support in `agents` with `onCreateContext` / `onDestroyContext`, typed `this.context`, and context propagation via `getCurrentAgent().context` and `getCurrentContext()`.

Also update `@cloudflare/ai-chat` to keep `context` in the async agent scope during chat/tool execution so nested `getCurrentAgent()` reads stay consistent.
