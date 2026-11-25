---
"agents": patch
"@cloudflare/think": patch
---

Think keeps the `onChatResponse` hook a turn owes across a reset on the turn's own Tasks run instead of in a storage key per turn; hooks an earlier version left are still fired on start.
