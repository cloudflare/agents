---
"@cloudflare/think": patch
---

Fix server-side `needsApproval` tool continuations remaining stuck after the
user approves them. Think now keeps approved/denied/errored tool parts in the
model transcript, updates its live transcript before an immediate continuation,
and persists and broadcasts terminal tool output emitted for a prior assistant
message. Continuation response frames are also labelled consistently so
`useAgentChat` can apply streamed continuation updates to the active UI state.
