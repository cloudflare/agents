---
"agents": patch
---

A Task attempt reads its checkpoint from the row it claimed instead of querying storage on every read, so a recovering chat turn or fiber runs fewer SQL statements.
