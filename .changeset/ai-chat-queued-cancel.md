---
"@cloudflare/ai-chat": patch
---

Cancelling a chat request while it waits in the queue now stops it from running, instead of the cancel being dropped. See [#2701](https://github.com/cloudflare/agents/issues/2701).
