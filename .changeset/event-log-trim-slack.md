---
"agents": patch
---

Internal change, no API change: an event log at its retention limit trims once per eighth of the limit, not on every write.
