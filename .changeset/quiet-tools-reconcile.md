---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Reconcile reused tool-call IDs one-to-one so later assistant messages and tool outputs stay attached to the correct turn.

Some providers reuse a `toolCallId` across turns. Assistant reconciliation now claims server rows one-to-one across the whole transcript instead of resolving each message against a conversation-wide `toolCallId` lookup, so a later assistant can no longer adopt an earlier row's ID and overwrite it on upsert. Terminal tool outputs merge from the server row a message actually resolved to; a message that resolved to no row may still merge from an unambiguous `toolCallId` whose tool input is identical, which keeps stale duplicates from persisting in a pre-terminal state. Think applies the same scoping when it keeps a server-resolved durable pause over a stale client's paused part.

Known limitations: a stale client duplicate of an assistant under a different message ID is now stored as its own row carrying the same `toolCallId`, where it previously overwrote the canonical row; providers that reject duplicate tool-call IDs in a prompt can fail on that transcript. When the older turn is absent from the submitted transcript (for example after Think compaction), a newer message reusing its `toolCallId` can still claim the older row.

`resolveToolMergeId` is deprecated. It carries the original conversation-wide behaviour and is no longer used by `@cloudflare/ai-chat` or `@cloudflare/think`; use `reconcileMessages` instead.
