---
"@cloudflare/think": minor
---

Think: scheduled tasks, submissions and extensions.

- Scheduled tasks from `getScheduledTasks()` move to new storage, and existing task rows migrate forward on first start. `getScheduledTasksScope()` is removed: a sub-agent now arms its own declared tasks, and its root wakes it. See [Scheduled tasks](https://developers.cloudflare.com/agents/api-reference/think/#scheduled-tasks).
- `submitMessages` stores each message whole instead of cutting messages over 1.8 MB; a submission over 16 MiB now throws `TaskSerializationError`. Metadata over about 1.8 MB is refused.
- A messenger reply is one delivery that answers again or apologizes after a reset, by how far it got. `messengerReplySnapshot`, `parseMessengerReplySnapshot`, `MessengerReplySnapshot`, `MESSENGER_REPLY_FIBER_NAME`, `DeliveryTag` and `defaultDeliveryTag` are removed, `messengerReplyRecoveryMode()` takes a stage, and `ThinkMessengerRuntime` no longer has `handleFiberRecovery()`, `hasLiveReply()`, `initialReplySnapshot()` or `executeLiveReply()`. `deliverMessengerReply()` takes `onStage` instead of `checkpoint`, `fiber` and `snapshotThread`. Replies a reset left open in think@0.24.0 are carried forward.
- A messenger reply finished by chat recovery is retried with backoff until a send fails more than twelve hours after the first try or three resets in a row cut its attempts off, instead of eight scheduled retries and then the next wake.
- A workflow prompt whose structured output exceeds a workflow event (1 MiB) ends `error` with that reason.
- A sandboxed extension's hooks and host calls work when Think is a sub-agent. Before, its host calls went to a separate Durable Object with the sub-agent's id, so its `beforeTurn` and `onChunk` did nothing.
- An extension's `permissions.network` hosts are enforced when the Worker re-exports `HostBridgeLoopback` (#3173). A context block's `type` in an extension manifest is now ignored, with a warning.
- `onSubmissionStatus` runs one submission's status reports in order: a report waits until the hook for the one before it returns, so a slow `running` hook can no longer finish after `aborted`.
