---
"@cloudflare/shell": patch
---

Make workspace parent directory creation safe under concurrent writes. When two
writes create files in the same missing directory at the same time, the
filesystem now creates the implicit parent idempotently without surfacing a
SQLite primary-key constraint error, while still emitting a single directory
create event.
