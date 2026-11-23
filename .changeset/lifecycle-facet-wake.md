---
"agents": patch
---

Jobs pushed by a capability inside a sub-agent now run: the sub-agent keeps them in its own queue and its root's alarm wakes it, instead of the sub-agent trying to set an alarm it cannot have.
