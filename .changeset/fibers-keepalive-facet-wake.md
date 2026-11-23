---
"agents": patch
---

Internal refactor, no API change: fiber recovery and keep-alive in a sub-agent are woken through the root's one wake per sub-agent, and existing root-side fiber wakes move over on the first start.
