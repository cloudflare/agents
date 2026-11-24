---
"agents": patch
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

The chat turn recognises a provider's context-overflow, rate-limit and transient errors by itself (by HTTP status and the common providers' context-window messages). `classifyChatError` is no longer needed for that in Think and still wins when it returns a classification; AIChatAgent now recovers a rate-limited or transient provider error like a dropped stream.
