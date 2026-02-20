---
"@cloudflare/ai-chat": patch
---

Fix duplicate assistant message persistence when clients resend full history with local assistant IDs that differ from server IDs.

`AIChatAgent.persistMessages()` now reconciles non-tool assistant messages against existing server history by content and order, reusing the server ID instead of inserting duplicate rows.
