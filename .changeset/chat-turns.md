---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

`AIChatAgent` and `Think` queue, stop and continue chat turns by the same rules.

- A message sent while a turn runs is stored when its own turn starts, so the transcript reads `U1, A1, U2, A2`. See [Message concurrency](https://github.com/cloudflare/agents/blob/main/docs/agents/chat-agents.md#messageconcurrency).
- A stop also drops the auto-continuations waiting behind it (`chat:continuation:dropped`).
- Auto-continuation runs only while the answered call's message is the last one; otherwise the next turn reads the result.
- An `aborted` result carries `reason: "stopped"` or `"interrupted"`.
- A waiting message is no longer dropped except by a clear, and a request cancelled in the queue never runs (#2928).
- A tool result answered with `autoContinue` just before a restart still continues the reply (#3101, #3142).
- New events: `chat:request:failed`, `chat:stream:stalled`, and in `Think` `tool:result`, `tool:approval` and `message:cancel`.
- A reply whose store fails runs `onChatResponse` with `error`.
- An `experimental_steering` message stays in the transcript (#3143).
- Under `latest`, `merge` and debounce, a request a newer one superseded stays superseded across a restart. Its question is stored with the newer request's, and a `merge` turn already at the front of the queue is no longer cancelled by a newer message.
