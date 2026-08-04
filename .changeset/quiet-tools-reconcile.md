---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Reconcile reused tool-call IDs one-to-one so later assistant messages and tool outputs stay attached to the correct turn.

Some providers reuse a `toolCallId` across turns. Assistant reconciliation now claims server rows one-to-one across the whole transcript instead of resolving each message against a conversation-wide `toolCallId` lookup, so a later assistant can no longer adopt an earlier row's ID and overwrite it on upsert. Terminal tool outputs merge from the server row a message actually resolved to; a message that resolved to no row may still merge from an unambiguous `toolCallId` whose tool input is identical, which keeps stale duplicates from persisting in a pre-terminal state.

`resolveToolMergeId` is deprecated. It carries the original conversation-wide behaviour and is no longer used by `@cloudflare/ai-chat` or `@cloudflare/think`; use `reconcileMessages` instead.
