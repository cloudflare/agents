---
"@cloudflare/ai-chat": patch
---

Fix chained tool-approval continuations so they keep streaming into the existing assistant message instead of splitting later continuation steps into a new persisted message.
