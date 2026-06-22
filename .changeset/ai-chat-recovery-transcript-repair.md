---
"@cloudflare/ai-chat": minor
---

Recover interrupted server-tool calls on resume instead of abandoning them.

When a turn is interrupted mid tool call (e.g. a server tool whose `execute()`
died with an evicted isolate, leaving an `input-available` orphan that nothing
will ever resolve), `AIChatAgent` now repairs the transcript before re-entering
inference on the recovered turn — the same behavior `@cloudflare/think` already
has. The interrupted tool part is flipped to an errored tool-result through the
shared `agents/chat` repair primitive, so the next `convertToModelMessages` no
longer 400s with `AI_MissingToolResultsError` and the turn continues.

Adds an overridable `repairInterruptedToolPart(part)` hook (default: flip to an
`output-error` result) so apps can customize the repaired shape for
client-resolved tools (e.g. preserve an interrupted question tool as text).
Repair only ever reshapes assistant tool parts; the corrected transcript is
persisted and broadcast through the normal write path.

Repair runs before EVERY inference chokepoint — live submit, tool
auto-continuation, `continueLastTurn`, `saveMessages`/retry, and the chat
recovery callbacks — mirroring how `@cloudflare/think` repairs before every
inference (the app owns `convertToModelMessages`, so the framework repairs
`this.messages` right before handing control to `onChatMessage`). This closes
the cases a recovery-only repair missed: a mixed client+server orphan whose
client replay drives an auto-continuation, and any agent running with
`chatRecovery` disabled. Repair is scoped per-part to dead SERVER orphans: a
part still legitimately awaiting a client (an `input-available` client tool or an
`approval-requested` part the user may still answer) is left verbatim, so a fresh
dead-server orphan at the leaf is repaired even when an unrelated abandoned client
orphan sits earlier in history. It is a no-op (no write, no broadcast) for a
healthy transcript.

The recovery-path stability wait (`waitUntilStable`) now gates on the narrower
client-resolvable predicate so a dead server-tool orphan no longer blocks
stability — it is repaired and the turn continues. `waitUntilStable` gains an
optional `pendingInteraction` predicate; its default (and the documented
semantics for app overrides) is unchanged.
