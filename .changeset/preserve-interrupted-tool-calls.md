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
