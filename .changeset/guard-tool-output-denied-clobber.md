---
"agents": patch
---

Stop a `tool-output-denied` chunk from clobbering a settled or user-approved
tool part in `agents/chat`.

`applyChunkToParts` now treats `tool-output-denied` as first-write-wins: it
leaves a part already in `output-available` / `output-error` / `output-denied`
untouched, and — importantly — no longer flips an `approval-responded`
(user-approved) part to `output-denied`. An auto-continuation that re-validates
the transcript can legitimately emit `tool-output-denied` for an approval the
AI SDK deems unneeded (e.g. a tool without `needsApproval`); previously that
silently turned a granted approval into a denial in the persisted message. This
matches the first-write-wins guards already on the `tool-input-*` handlers and
benefits both `@cloudflare/ai-chat` and `@cloudflare/think`.

`isReplayChunk` now recognizes the same replayed `tool-output-denied` (for a
part already settled or in `approval-responded`). The server-side guard only
protects the persisted message; without this, the stale denial chunk was still
stored in the resumable-stream buffer and broadcast to connected clients, where
AI SDK v6's in-place `updateToolPart` would regress the rendered tool part back
to `output-denied` (and replay it on reconnect). Filtering it at the broadcast
boundary keeps the client UI consistent with the persisted state.

`tool-approval-request` gains the same treatment on both paths: a
first-write-wins guard in `applyChunkToParts` (so a replayed approval request
can't regress an already-`approval-responded` or settled part back to
`approval-requested`, discarding the user's decision) and a matching
`isReplayChunk` branch (so the replayed request isn't stored or broadcast,
which would otherwise revert an approved tool to re-showing Approve/Reject on
the client and on reconnect).
