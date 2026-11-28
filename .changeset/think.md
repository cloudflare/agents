---
"agents": minor
"@cloudflare/think": minor
---

Think.

- Scheduled tasks from `getScheduledTasks()` move to new storage, and existing task rows migrate forward on first start. `getScheduledTasksScope()` is removed: a sub-agent now arms its own declared tasks, and its root wakes it. See [Scheduled tasks](https://developers.cloudflare.com/agents/api-reference/think/#scheduled-tasks).
- Experimental `agents/context`: `freezeSystemPrompt`, `refreshSystemPrompt` and `reminder` moved from `ContextBlocks` to the new `Context`, `ContextBlocks` no longer takes a prompt store, prompt stores are only read, turns keep their first system prompt, and `set_context` blocks are not echoed back.
- Messenger replies: `messengerReplySnapshot`, `parseMessengerReplySnapshot`, `MessengerReplySnapshot`, `MESSENGER_REPLY_FIBER_NAME`, `DeliveryTag` and `defaultDeliveryTag` are removed, `messengerReplyRecoveryMode()` takes a stage, `ThinkMessengerRuntime` no longer has `handleFiberRecovery()`, `hasLiveReply()`, `initialReplySnapshot()` or `executeLiveReply()`, and `deliverMessengerReply()` takes `onStage` instead of `checkpoint`, `fiber` and `snapshotThread`; a reply cut off by a reset answers again or apologizes, and replies a reset left open in think@0.24.0 are carried forward.
- `submitMessages` stores messages whole up to 16 MiB.
- `deliverNotice` before the first webhook no longer throws.
- Sandboxed extensions work in sub-agents and enforce `permissions.network` when the Worker re-exports `HostBridgeLoopback` (#3173).
- With `contextOverflow.proactive` on AI SDK 6, the steps after the guard compacted no longer send the whole history again.
