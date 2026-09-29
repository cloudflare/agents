---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Reconcile reused tool-call IDs one-to-one so later assistant messages and tool outputs stay attached to the correct turn.

Some providers reuse a `toolCallId` across turns. Assistant reconciliation now claims server rows one-to-one across the whole transcript instead of resolving each message against a conversation-wide `toolCallId` lookup, so a later assistant can no longer adopt an earlier row's ID and overwrite it on upsert. Matching a row by `toolCallId` also requires the same tool and the same input (object key order ignored), compared in the host's persisted form (ai-chat's truncation of large provider-executed tool payloads included). A reused ID for a different call keeps its own row. Terminal tool outputs merge only from the server row a message resolved to; a message that resolved to no row gets none, and a result on any other row is never copied in. Think applies the same rule when it keeps a server-resolved durable pause over a stale client's paused part.

A stale client copy of an assistant, submitted under a different message ID alongside the original, is no longer persisted when it is not the last submitted message and consists only of pending tool calls already settled on the original. That keeps the same `toolCallId` from reaching the next prompt twice.

Known limitations:

- Repeated identical assistants (the same reused call, or the same text reply) are paired with stored rows in transcript order, so when an older turn is missing from the submitted transcript (for example after Think compaction), a newer identical one can still claim the older row.
- A message whose own row lacks one of its calls no longer borrows that result from another row; the call stays pending.
- A stale copy that carries other content or is the last submitted message is kept as its own row with the same `toolCallId`.
- Routing a client tool result or approval for a reused `toolCallId` is unchanged: ai-chat applies it to the oldest message carrying the ID, Think to the newest.
- A stale copy holding only some of a stored message's parallel tool calls still claims that row and replaces it, dropping the other calls, as before this change.

`resolveToolMergeId` is deprecated. It carries the original conversation-wide behaviour and is no longer used by `@cloudflare/ai-chat` or `@cloudflare/think`; use `reconcileMessages` instead.
