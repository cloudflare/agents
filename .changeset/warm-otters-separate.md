---
"agents": patch
"@cloudflare/think": minor
"@cloudflare/voice": patch
---

Preserve spacing between streamed text segments separated by tool calls. Think messenger delivery and Voice now share the same boundary-aware text joining logic from `agents/chat`.

Existing users must:

- Replace imports of `textDeltaFromStreamChunk()` from `@cloudflare/think/messengers` with `TextStreamCallback`, passing it the complete structured stream events.
- Upgrade to `agents@0.21.0` when installing `@cloudflare/think@0.16.0` or `@cloudflare/voice@0.3.6`; both now require `agents >=0.20.2`.
- Update exact-text expectations if they relied on segments around tool calls being concatenated without a space.
