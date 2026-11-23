---
"agents": patch
---

`setState` with a state too large for one SQLite row now throws a `SqlError` that names the row limit and what to do, instead of a bare `SQLITE_TOOBIG`.
