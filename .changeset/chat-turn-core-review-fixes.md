---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Chat recovery, stops, persists and continuations in `AIChatAgent` and `Think` follow the review fixes of the turn core: a recovery is taken over at the first chunk with content, a stop of a recovery or of a turn routed into recovery ends it, every persist a turn makes checks for a clear before each write, and a tab drops a message a stream opened and left empty.
