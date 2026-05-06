---
"agents": patch
"@cloudflare/ai-chat": patch
---

Scope chat tool call IDs by assistant turn and per-tool ordinal, preserving the provider/client-local ID as `originalToolCallId`. This prevents repeated provider-local IDs like `functions.calc:0` from colliding across turns while keeping replay chunks and client tool results mapped back to the active tool part.
