---
"agents": patch
---

Export `reconcileOrphanPartial` from `agents/chat`.

This is the shared primitive that merges a freshly-reconstructed orphaned stream
partial onto an assistant message that already owns its target id (an early
persist at tool-approval time, or a continuation resuming the prior assistant
message). It keeps all existing parts, appends only reconstructed parts whose
`toolCallId` is not already present (so a recovery replay never duplicates a
tool call), and overlays incoming metadata onto existing — preserving an
in-place tool result that lives only in storage rather than letting a replayed
chunk re-advance it. `@cloudflare/ai-chat`'s orphan-persist path now uses it;
hosts whose orphan persist only runs at stream finalize don't need it (the
shared reconstruction is already idempotent by `toolCallId`).

Additive export only — no behavior change to existing APIs.
