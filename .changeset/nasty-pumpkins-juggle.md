---
"@cloudflare/ai-chat": minor
---

Add `AIChatAgent.messageConcurrency` to control overlapping `sendMessage()`
submits with `queue`, `latest`, `merge`, `drop`, and `debounce` strategies.
Enhance `saveMessages()` to accept a functional form for deriving messages
from the latest transcript, and return `{ requestId, status }` so callers
can detect skipped turns.
