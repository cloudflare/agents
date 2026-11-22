---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

`AIChatAgent` and `Think` handle incoming chat protocol messages through one shared dispatch: an unparseable chat request is reported as `chat:request:failed` (stage `parse`) and ends with an error frame to the sending tab in both, a non-POST chat request is no longer passed to `onMessage`, and `Think` now emits `tool:result`, `tool:approval` and `message:cancel`.
