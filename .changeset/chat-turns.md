---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Chat turns.

- **Upgrade `agents`, `@cloudflare/ai-chat` and `@cloudflare/think` together.** `@cloudflare/ai-chat` and `@cloudflare/think` require `agents` 0.35.0 or later. Released `@cloudflare/ai-chat` 0.12.x and `@cloudflare/think` 0.24.x can't run a turn on this `agents`, so `agents/chat` no longer keeps exports for them. `TurnQueue`, `SubmitConcurrencyController`, `AbortRegistry`, `ResumableStream`, `ContinuationState`, `AutoContinuationController`, `buildInClauseStrings` and `enforceRowSizeLimit` are removed, and an old pairing fails at bundle time with a missing export.
- A message sent while a turn runs is stored when its own turn starts, so the transcript reads `U1, A1, U2, A2`.
- Waiting messages are dropped only by a clear, and a cancelled or superseded one stays so across a restart (#2928).
- A stop also drops waiting auto-continuations, an `aborted` result carries `reason: "stopped"` or `"interrupted"`, and an `autoContinue` tool result answered just before a restart still continues the reply (#3101, #3142).
- New events: `chat:request:failed`, `chat:stream:stalled`, `chat:continuation:dropped`, and Think's `tool:result`, `tool:approval`, `message:cancel`.
- A tool answer that arrives while a continuation runs now schedules the next continuation, whose turn waits behind the running one. It starts one coalesce window after the reply ends, and a stop that drops it reports its own request id instead of `null`.
- A tab that asks to resume right after answering a client tool is told to wait for the continuation, even when the answer is still being stored; it used to be told there was nothing to resume.
- A resume request that names several requests gets the end of each one that ended, not only the newest, also when the tab is parked on a continuation or offered a pending error.
- `AIChatAgent` runs its turns as durable Task runs on the shared chat module, one implementation with `Think`'s harness.
- An `AIChatAgent` request whose `onChatMessage` returns no response ends with `outcome: "skipped"`.
- An `AIChatAgent` turn that a clear reaches, waiting or running, ends with `outcome: "skipped"` and keeps nothing.
- An `AIChatAgent` turn that recovery gives up on reports its end to `onChatResponse` once, with `status: "error"` and the terminal message, after `onExhausted`.
- `AIChatAgent` turns store their messages directly, so a `persistMessages` override no longer sees a turn's writes.
- A request context over the row budget is no longer kept in memory.
- A tab that reconnects learns how a request ended by naming it in its resume request, as the client does; a tab that names none is told of the newest end only when it was an error.
- A reply that completed is kept as stored, and `Think` leaves the reasoning it ends in out of the model request only; a reply cut off in its reasoning is still removed. See [Reasoning at the end of a reply](https://github.com/cloudflare/agents/blob/main/docs/agents/client-tools-continuation.md#reasoning-at-the-end-of-a-reply).
