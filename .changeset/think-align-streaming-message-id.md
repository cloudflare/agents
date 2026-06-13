---
"@cloudflare/think": patch
---

Align the streamed assistant message id with the persisted id during chat streaming. Providers that emit no `start.messageId` (e.g. Workers AI) previously left the client to generate its own id, so the live stream and the persisted message broadcast couldn't reconcile by id and the originating tab briefly rendered the turn twice before collapsing. The `start` chunk is now stamped with the allocated assistant id for new turns (continuations are unaffected). Mirrors the same fix in `@cloudflare/ai-chat`.
