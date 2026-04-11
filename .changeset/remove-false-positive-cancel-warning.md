---
"@cloudflare/ai-chat": patch
---

Remove false-positive "Stream was still active when cancel was received" warning that fired on every cancellation, even when the user correctly passed `abortSignal` to `streamText()`
