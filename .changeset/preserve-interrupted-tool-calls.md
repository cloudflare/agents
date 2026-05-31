---
"@cloudflare/think": patch
---

Transcript repair now preserves an interrupted/abandoned tool call as an errored result instead of deleting it.

Previously, a tool call with no recorded output (e.g. a tool interrupted mid-execution by a deploy, or an `ask_user` answered by the user's next message) was **removed** from the durable transcript before the next turn. That made the call visibly "disappear" from the broadcast transcript and let the model silently **re-run** it (duplicating non-idempotent side effects).

It is now flipped to `state: "output-error"` with an explanatory message, so:

- the user-visible record survives (no disappearing tool calls),
- the model sees the tool errored rather than re-running it blind, and
- the provider still receives a valid tool-result (no `AI_MissingToolResultsError`).

Malformed tool `input`s are normalized in the same pass: a stringified-JSON `input` is parsed back into an object, and a missing/`null` `input` on a settled or interrupted tool call is defaulted to `{}` (Anthropic rejects a `tool_use` block whose `input` is absent).

As a last-line backstop, `convertToModelMessages` is now called with `ignoreIncompleteToolCalls: true`, so any incomplete tool call that still slips past the repair (compaction edges, `addToolOutput` races, unrecognized part shapes) is dropped at conversion rather than 400ing the provider.

Repair recognizes all of the AI SDK's settled terminal tool states — `output-available`, `output-error`, and `output-denied` (a user-denied approval) — via a single shared predicate, so a tool call that already has a provider-acceptable result is never re-flipped into a generic errored result. Previously `output-error` was re-flipped on every turn (clobbering a real `errorText` with the generic "interrupted" message and emitting spurious `chat:transcript:repaired` events/writes/broadcasts for the life of the conversation), and `output-denied` was converted into an errored result that lost the denial. A denied tool result is also now flushed to durable storage immediately (like other settled results) so it survives an eviction.
