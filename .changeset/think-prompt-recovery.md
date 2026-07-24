---
"@cloudflare/think": minor
---

Add DO chat recovery to the `step.prompt()` retry loop.

When a prompt wait times out (e.g. the Think Durable Object was restarting during a deploy), the retry loop first tries to recover the in-flight submission via the DO's built-in chat recovery before discarding it and resubmitting. It inspects the submission and, if it is still `pending`/`running` (recovery in progress) or already `completed`, re-waits for the original completion event — reusing the in-flight turn instead of wasting it.

Recovery is resilient to the DO being temporarily unreachable: while `inspectSubmission` fails (the DO is still coming back up after a deploy), the submission is treated as "still recovering" rather than dead, so the loop backs off and re-checks rather than abandoning the durable submission. Recovery runs for a bounded number of rounds; if it can't recover within that budget it falls through to the cancel + fresh-resubmit path. It never throws out of `step.prompt()` — a recovery-wait timeout, a terminal failure of the recovered turn, or invalid recovered output all fall through to a fresh retry.

Each retry attempt uses a distinct event type derived from its key, so a delivered workflow event maps 1:1 to the submission that produced it and no event can be misattributed across attempts. The DO re-emits an interrupted submission's completion event with that same type, which the recovery wait listens on.

Recovery is only attempted for `ThinkPromptTimeoutError` with `retryOnTimeout` enabled. Non-timeout errors (provider errors, validation failures) still go through the cancel + full-retry path. This leverages Think's existing submission recovery and fiber mechanisms — no new RPC is needed (`inspectSubmission` already exists).
