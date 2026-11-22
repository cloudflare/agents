---
"agents": patch
---

Internal refactor, no API change: agent-tool runs keep their own table and jobs, and a detached run's backbone is a Lifecycle job instead of a schedule row (a row an earlier version armed still runs once).
