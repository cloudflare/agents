---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

A sub-agent upgraded from a version that kept chat streams in the old `cf_ai_chat_stream_*` tables now empties those tables instead of dropping them, so its first start after the upgrade cannot reset the storage of the agent tree it runs in.
