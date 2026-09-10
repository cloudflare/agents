---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

perf(sessions): `updateMessage(message, { compare: "none" })` for a caller that already knows the row changed. The default (`"stored"`) still reads the row and its continuations back and writes nothing when the stored form is byte-identical; `"none"` probes the key-side columns only and rewrites, so a changed multi-row message costs 2 rows read instead of one per continuation, and its payload is never read. Plumbed through `upsertMessage` and the sync aperture. Think's tool-result and approval applies, ai-chat's tool-part updates and its transcript persist (for messages the mirror holds a different version of) use it.
