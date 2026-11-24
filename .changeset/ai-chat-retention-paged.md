---
"@cloudflare/ai-chat": patch
---

AIChatAgent retention (`maxPersistedMessages`) deletes up to 20,000 messages past the limit per persist, reading only those, instead of reading the whole transcript on every persist.
