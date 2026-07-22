---
"agents": patch
---

Harden MCP connection recovery: honor retry budgets for resolved connection failures, finish in-flight restore work before stable-id migration, and close connections replaced by the legacy `connect()` path.
