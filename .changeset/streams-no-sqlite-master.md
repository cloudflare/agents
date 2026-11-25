---
"agents": patch
---

Streams no longer reads `sqlite_master` on start: it checks for its old chunk table with a read that returns no rows.
