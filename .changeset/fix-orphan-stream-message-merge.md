---
"@cloudflare/ai-chat": patch
"agents": patch
---

Fix `AIChatAgent` orphaned-stream recovery merging a new assistant turn into the previous assistant message (#1691).

When a stream was interrupted before its final assistant message was persisted (Durable Object hibernation, deploy churn, isolate restart, reconnect), orphan recovery reconstructed the message from stored chunks. If those chunks carried no provider `start.messageId` — the common case — recovery fell back to the _last_ assistant message in history. That is correct for a continuation, but wrong for a normal new turn after a later user message: the recovered chunks for the new turn were appended onto the previous assistant message, corrupting both the persisted transcript and future model context.

The assistant message id allocated when a stream starts is now persisted in the resumable-stream metadata (`ResumableStream.start()` records `message_id`). When the reconstructed chunks carry no provider `start.messageId` — the common case, and the one that triggered the bug — orphan recovery now uses this stored id instead of the last-assistant fallback, so a new turn becomes its own message and a continuation still merges into the message it was extending (it stored the cloned last-assistant id). A provider `start.messageId`, when present, still wins, matching the live path which adopts it for new turns. Stream rows written before this release have no stored id and keep the previous behavior (provider id if present, otherwise the last assistant message). The metadata migration adds a single column, guarded by a schema check so it runs only once.

This also fixes two related variants of the same corruption on the durable (`chatRecovery`) continuation path:

- When a stream was persisted early (e.g. at a tool-approval pause) and then recovered, the merge re-appended chunks it had already stored, leaving two parts for the same tool call. Recovery now skips reconstructed parts whose `toolCallId` already exists on the message.
- When a new turn was interrupted before any assistant part was persisted — either because it was cut off in the window before the first chunk materialized, or because `onChatRecovery` returned `{ persist: false }` — recovery would "continue" it by cloning the previous assistant message, merging the new turn into it. Recovery now detects that the conversation leaf is still the user message (no partial to continue) and re-runs the turn fresh, so it becomes its own message.

`@cloudflare/think` is unaffected — its session-tree recovery already allocates a distinct message id per orphan and never falls back to the last assistant message.
