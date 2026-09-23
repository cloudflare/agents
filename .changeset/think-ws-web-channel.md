---
"@cloudflare/think": patch
---

WebSocket chat turns now run on the implicit `web` channel (#2255).

A `web` entry in `configureChannels()` (its `instructions`, `tools`, and `maxTurns`) now applies to turns sent from `useAgentChat`, and `this.activeChannel` is set during those turns. Previously these turns ran without a channel context, so the `web` policy was silently ignored.

The channel is stamped on each new user message and kept when the client re-sends the transcript, so continuations after client tool results and recovered turns keep the `web` channel. A channel in client-sent message metadata is still ignored. `runTurn()` and `chat()` calls without a `channel` are unchanged and run without a channel context.

If you configured a `web` channel, its policy now takes effect for browser chat; check that its `tools` narrowing and `maxTurns` suit that traffic.
