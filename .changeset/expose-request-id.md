---
"@cloudflare/ai-chat": patch
---

Expose `requestId` in `OnChatMessageOptions` so handlers can send properly-tagged error responses for pre-stream failures.

Also fix `saveMessages()` to pass the full options object (`requestId`, `abortSignal`, `clientTools`, `body`) to `onChatMessage` and use a consistent request ID for `_reply`.
