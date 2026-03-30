---
"@cloudflare/ai-chat": patch
---

Fix `useAgentChat().stop()` so it cancels active server-side tool continuation streams.
