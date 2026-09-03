---
"@cloudflare/ai-chat": minor
---

Store AIChatAgent messages through `agents/sessions` while preserving the mutable `messages` array, destructive regeneration, retention, broadcasts, and v4 message conversion.

**Migration on first wake, no rollback.** Existing `cf_ai_chat_agent_messages` rows are imported once into a linear Sessions chain. The old table is dropped only after every row imported; a row that fails to parse keeps the table in place so it stays recoverable, and the import retries on the next start. Once an object has migrated, rolling back to the previous release leaves it with an empty conversation. Rolling forward again is safe.

**`this.messages` is empty until `onStart`.** Boot no longer loads the transcript synchronously in the constructor. The legacy lift and a single bounded hydration run in `onStart`, so a subclass that read `this.messages` in its constructor now sees `[]`; read it from `onStart` or later. The array is then mirrored from the Sessions change feed.

`hydrationByteBudget` (32 MiB) bounds wake-time hydration. `get-messages` streams its response instead of serializing the whole transcript; clients calling `.json()` on it are unaffected.

There is nothing to configure about how a message is stored: a message too large for one SQLite row is split across continuation rows and reassembled on read, and a stored row is exactly what the write returned.
