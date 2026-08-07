---
"agents": patch
"@cloudflare/think": minor
"@cloudflare/voice": patch
---

Preserve spacing between streamed text segments separated by tool calls. Think messenger delivery and Voice now share the same boundary-aware text joining logic from `agents/chat`. Remove the unsafe `textDeltaFromStreamChunk()` messenger export; consume streams through `TextStreamCallback` so structured boundaries are retained.
