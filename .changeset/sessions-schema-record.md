---
"agents": patch
---

Sessions keeps its schema version in the Lifecycle's one schema record and checks its tables without reading `sqlite_master` at start; no API change.
