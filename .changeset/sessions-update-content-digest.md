---
"agents": patch
---

perf(sessions): decide an update's "unchanged" outcome from a content digest instead of a read-back. Every message write now stamps a SHA-256 of the stored form on an additive `content_hash` column, so `updateMessage()` compares digests on the key-side probe it was already doing: the stored payload is never read back, the continuation rows of a large message are never read at all, and a digest match still writes nothing and dispatches nothing. A changed 3.2 MiB message costs 2 rows read instead of 6, and an unchanged one 1 instead of 5. Rows written before the column existed carry a `null` digest and fall back to the old reassembling compare once, which stamps them; no backfill pass runs and no public option changes.
