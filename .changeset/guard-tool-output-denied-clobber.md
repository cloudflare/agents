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
