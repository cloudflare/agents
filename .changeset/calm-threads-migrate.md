---
"@cloudflare/ai-chat": minor
---

Store AIChatAgent messages through `agents/sessions` while preserving the mutable `messages` array, destructive regeneration, retention, broadcasts, and v4 message conversion.

Boot no longer loads the transcript synchronously in the constructor. The legacy lift and a single bounded hydration run in `onStart` under a new `hydrationByteBudget` (32 MiB), the live array is mirrored from the Sessions change feed, and `get-messages` streams its response instead of serializing the whole transcript. Existing `cf_ai_chat_agent_messages` rows migrate once into a linear Sessions chain and the old table remains as `cf_ai_chat_agent_messages__lifted_v1`. This is a one-way automatic migration; rollback requires restoring the tombstone table.

Attachment storage is on by default; `sessionAttachments` now tunes the payload ceiling, the logical locator prefix, and the reconstructor rather than switching extraction on. Extraction itself is not a policy: a payload is chunked out of a message row only when the serialized row would otherwise exceed 1.5 MiB.
