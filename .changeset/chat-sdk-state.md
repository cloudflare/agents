---
"agents": patch
---

Add `agents/chat-sdk`, a Chat SDK `StateAdapter` backed by Agents sub-agents.

This new package entrypoint exports:

- `createChatSdkState()`, a convenience factory for Chat SDK `state`.
- `ChatSdkStateAdapter`, the concrete adapter implementation.
- `ChatSdkStateAgent`, the default sub-agent used for durable Chat SDK state.
- `defaultThreadShard()` and `defaultKeyShard()`, the default sharding helpers used by the adapter.

The adapter stores Chat SDK subscriptions, concurrency locks, pending queues, generic cache entries, callback metadata, thread and channel state, persisted message history, and transcript lists in Durable Object SQLite. State is sharded through `parent.subAgent()` so a messenger ingress Agent can keep Chat SDK infrastructure state inside child facets instead of requiring a separate top-level Durable Object binding for every state shard.

`createChatSdkState()` now works with the default `ChatSdkStateAgent` class when it is re-exported from the Worker entrypoint. It also defaults `parent` from `getCurrentAgent()` when called inside an Agent lifecycle method or request handler, so the common setup is:

```ts
export { ChatSdkStateAgent } from "agents/chat-sdk";

const chat = new Chat({
  adapters,
  state: createChatSdkState()
});
```

Applications that need custom state behavior can still pass a custom `agent` subclass and explicit `parent`.

This also documents the sub-agent configuration model more clearly: production Workers should export facet classes, but facet-only child classes do not belong in `new_sqlite_classes` unless they are also used as top-level Durable Objects. Test wrangler configs may still include facet classes as test-only Durable Object bindings for `@cloudflare/vitest-pool-workers` compatibility, while keeping them out of `new_sqlite_classes`.
