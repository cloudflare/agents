---
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

fix(think): hold the auto-continuation barrier for a slow tool sibling pending only in the streaming accumulator (#1649 follow-up)

When the model fans out parallel client tool calls in one streaming step and a
fast sibling resolves mid-stream, its `autoContinue` schedules the continuation
and arms the 50ms barrier timer. That timer can fire while the assistant
message still lives only in the streaming accumulator (`_streamingAssistant`)
and has not yet been persisted. `_hasIncompleteToolBatch()` only scanned
`this.messages`, so it saw a stale (prior) leaf, reported "not mid-batch", and
the fast path fired the continuation — bypassing the barrier. When the stream
then persisted with the slow sibling still `input-available`, the continuation's
transcript repair errored it with "The tool call was interrupted before a result
was recorded", and the slow RPC result (2–5s later) arrived too late.

`_hasIncompleteToolBatch()` now inspects the streaming accumulator first (the
true in-flight leaf), falling back to the latest persisted assistant message,
so a slow sibling keeps the barrier closed until its result lands or the
existing 60s timeout elapses.

The same guard is applied to `@cloudflare/ai-chat`'s `_hasIncompleteToolBatch`
for symmetry. ai-chat's barrier runs in the post-stream continuation turn (where
`_streamingMessage` is already null), so it does not exhibit the bypass today —
this keeps the two implementations aligned and safe against future flow changes.
