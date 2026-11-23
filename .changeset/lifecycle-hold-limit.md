---
"agents": patch
---

A job whose callee keeps failing with transient platform errors for 15 minutes now reaches its owner's `onJobError`, so one bad queue item no longer blocks the items behind it forever.
