---
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

Fix auto-continuation firing before all parallel client-tool results arrive
(#1649). When the model emitted multiple tool calls in one step and the client
resolved them independently via `addToolOutput`, a fast result's `autoContinue`
could trigger the next inference while a slower sibling was still
`input-available`. That fed the provider an incomplete tool-result set
(`MissingToolResultsError`) or — via the transcript-repair backstop — silently
flipped the in-flight sibling to errored and ran a spurious extra continuation.

Auto-continuation now waits until the transcript is stable (no
`input-available`/`approval-requested` parts) before continuing, so a fanned-out
tool batch coalesces into a single continuation regardless of result arrival
order. The wait is bounded, so a genuinely orphaned tool call (e.g. the client
disconnected mid-batch) still falls through to the existing backstop instead of
pinning the continuation open.
