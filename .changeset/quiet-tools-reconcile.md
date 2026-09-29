---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Reconcile reused tool-call IDs one-to-one so later assistant messages and tool outputs stay attached to the correct turn.

Some providers reuse a `toolCallId` across turns. Assistant reconciliation now claims server rows one-to-one across the whole transcript instead of resolving each message against a conversation-wide `toolCallId` lookup, so a later assistant can no longer adopt an earlier row's ID and overwrite it on upsert. Matching a row by `toolCallId` also requires the same tool and the same input (object key order ignored), so a reused ID for a different call keeps its own row even when the older turn is missing from the submitted transcript. Terminal tool outputs merge from the server row a message resolved to; a call that row does not carry merges only from a row no submitted message claimed, and only when exactly one such row holds the same call. Anything more ambiguous is left pending rather than risk attaching a result to the wrong turn. Tool calls are compared in the host's persisted form (ai-chat's truncation of large provider-executed tool payloads included), so an optimistic client copy still reconciles to its stored row. Think applies the same rules when it keeps a server-resolved durable pause over a stale client's paused part.

A stale client copy of an assistant, submitted under a different message ID alongside the original, is no longer persisted when it is not the last submitted message and consists only of pending tool calls already settled on the original. That keeps the same `toolCallId` from reaching the next prompt twice.

Known limitations: a stale copy that carries other content (for example text) or is the last submitted message is kept as its own row with the same `toolCallId`, where it previously overwrote the original row. Providers that reject duplicate tool-call IDs in a prompt can fail on that transcript. When the older turn is absent from the submitted transcript and a newer call reuses its `toolCallId` with the same tool and input, the two are indistinguishable and the newer one can still claim the older row.

`resolveToolMergeId` is deprecated. It carries the original conversation-wide behaviour and is no longer used by `@cloudflare/ai-chat` or `@cloudflare/think`; use `reconcileMessages` instead.
