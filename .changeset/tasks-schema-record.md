---
"agents": patch
---

Internal refactor, no API change: Tasks keeps its schema version in the Lifecycle's single schema record, so a start reads one KV key fewer.
