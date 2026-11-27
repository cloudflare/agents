---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Chat turns in `AIChatAgent` and `Think`.

- **Upgrade `agents`, `@cloudflare/ai-chat` and `@cloudflare/think` together.** `@cloudflare/ai-chat` and `@cloudflare/think` require `agents` 0.35.0 or later. Released `@cloudflare/ai-chat` 0.12.x and `@cloudflare/think` 0.24.x can't run a turn on this `agents`, so `agents/chat` no longer keeps exports for them. `TurnQueue`, `SubmitConcurrencyController`, `AbortRegistry`, `ResumableStream`, `ContinuationState`, `AutoContinuationController`, `buildInClauseStrings` and `enforceRowSizeLimit` are removed, and an old pairing fails at bundle time with a missing export.
- A message sent while a turn runs is stored when its own turn starts, so the transcript reads `U1, A1, U2, A2`.
- Waiting messages are dropped only by a clear, and a cancelled or superseded one stays so across a restart (#2928).
- A stop also drops waiting auto-continuations, an `aborted` result carries `reason: "stopped"` or `"interrupted"`, and a tool result answered just before a restart still continues the reply (#3101, #3142).
- New events: `chat:request:failed`, `chat:stream:stalled`, `chat:continuation:dropped`, and Think's `tool:result`, `tool:approval`, `message:cancel`.
