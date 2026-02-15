---
"@cloudflare/ai-chat": patch
---

Persist request context across Durable Object hibernation.

Persist `_lastBody` and `_lastClientTools` to SQLite so custom body fields and client tool schemas survive Durable Object hibernation during tool continuation flows (issue #887). Add test coverage for body forwarding during tool auto-continuation, and update JSDoc for `OnChatMessageOptions.body` to document tool continuation and hibernation behavior.
