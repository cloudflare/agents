---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Batch and pack chat-persistence SQLite writes to reduce rows written and round-trips.

- `agents`: `ResumableStream` now **packs** each buffered group of stream chunks into a single SQLite row (a JSON array of chunk bodies) instead of writing one row per chunk. Single-chunk and large-chunk segments are stored unwrapped, and a per-segment byte cap keeps rows within the 2 MB SQLite row limit. This cuts chunk rows written / stored / scanned-on-replay by up to ~10×. Reads (replay, orphan reconstruction, `getStreamChunks`) transparently unpack both packed segments and legacy per-chunk rows, so existing stored data keeps working. Adds shared `buildInClauseStrings` and `MAX_BOUND_PARAMS` helpers exported from `agents/chat`.
- `@cloudflare/ai-chat`: message cleanup (stale-row pruning and `maxPersistedMessages` enforcement) previously issued one `DELETE` per row in a loop; it now deletes rows in batched `DELETE ... WHERE id IN (...)` queries (capped at 100 bound parameters per query).
- `@cloudflare/think`: `deleteSubmissions()` cleanup previously issued one `DELETE` per terminal submission (up to 500 per call); it now deletes rows in batched `DELETE ... WHERE submission_id IN (...)` queries.
- `@cloudflare/ai-chat` & `@cloudflare/think`: chat-recovery incident TTL sweep previously deleted each stale incident with a separate awaited `storage.delete(key)` (which also defeats Durable Object write-coalescing); it now deletes incidents in batched `storage.delete(keys)` calls (up to 128 keys per call).
