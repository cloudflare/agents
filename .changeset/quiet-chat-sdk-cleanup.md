---
"agents": patch
---

Await Chat SDK state-agent cleanup scheduling during startup so tests and short-lived worker isolates do not leave dangling cleanup work.
