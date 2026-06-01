---
"@cloudflare/think": patch
"agents": patch
---

Fix server-side `needsApproval` tool continuations remaining stuck after the
user approves them. Think now keeps approved/denied/errored tool parts in the
model transcript, updates its live transcript before an immediate continuation,
and persists and broadcasts terminal tool output emitted for a prior assistant
message. Continuation response frames are also labelled consistently so
`useAgentChat` can apply streamed continuation updates to the active UI state.
A pending `approval-responded` tool is no longer mis-reported by the
incomplete-tool-call backstop, so approval continuations stop logging a false
"repair gap" warning and emitting a spurious `chat:transcript:repaired` event.

The cross-message tool result now flows through `StreamAccumulator`'s
`cross-message-tool-update` action and a shared, replay-safe
`crossMessageToolResultUpdate` builder (exported from `agents/chat`): it matches
terminal states for first-write-wins idempotency against provider replays (e.g.
the OpenAI Responses API, #1404), preserves a streamed `preliminary` flag, and
lets `Think` skip redundant writes/broadcasts when a result is already settled.
