---
"agents": minor
---

Breaking (experimental): in the shared harness interface, a `transcript` event replaces `reset`, and `placed` and `done` statuses can report the id a harness gave a user message, which Channels maps to the inbound message's id. `piChannelsHarness` no longer takes a `kv` option. See [Channels](https://github.com/cloudflare/agents/tree/main/packages/agents/src/experimental/channels/docs/CONTEXT.md).
