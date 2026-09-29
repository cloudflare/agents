---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Reconcile reused tool-call IDs one-to-one so later assistant messages and tool outputs stay attached to the correct turn.

Some providers reuse a `toolCallId` across turns. Assistant reconciliation now claims server rows one-to-one across the whole transcript instead of resolving each message against a conversation-wide `toolCallId` lookup, so a later assistant can no longer adopt an earlier row's ID and overwrite it on upsert. Matching a row by `toolCallId` also requires the same tool and the same input (object key order ignored), so a reused ID for a different call keeps its own row even when the older turn is missing from the submitted transcript. Terminal tool outputs merge from the server row a message resolved to; a call that row does not carry merges only from a row no submitted message claimed, and only when exactly one such row holds the same call. Anything more ambiguous is left pending rather than risk attaching a result to the wrong turn. Think applies the same rules when it keeps a server-resolved durable pause over a stale client's paused part.

Known limitations: a stale client duplicate of an assistant, submitted under a different message ID alongside the original, is stored as its own row carrying the same `toolCallId` and stays pending, where it previously overwrote the original row. Providers that reject duplicate tool-call IDs in a prompt can fail on that transcript. When the older turn is absent from the submitted transcript and a newer call reuses its `toolCallId` with the same tool and input, the two are indistinguishable and the newer one can still claim the older row.

`resolveToolMergeId` is deprecated. It carries the original conversation-wide behaviour and is no longer used by `@cloudflare/ai-chat` or `@cloudflare/think`; use `reconcileMessages` instead.
