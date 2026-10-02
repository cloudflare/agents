---
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

Continuation turns that fail before streaming now report an error to clients and `onChatResponse` instead of appearing to hang (#2381). See [Client tools](https://github.com/cloudflare/agents/blob/main/docs/agents/client-tools-continuation.md).
