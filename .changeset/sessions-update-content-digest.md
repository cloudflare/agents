---
"agents": patch
---

perf(sessions): `updateMessage()` decides "unchanged" from a SHA-256 of the stored form, kept on a new nullable `content_hash` column, instead of reading the stored message back. An unchanged update of a 3.2 MiB message reads 1 row instead of 5, and a changed one 2 instead of 6. Rows written before the column existed fall back to the old comparison once and get a digest; there is no backfill.
