---
"agents": patch
---

Fix `OpenCodeHarness` `wait()` and `prompt()` pausing for `heartbeatMs / 30` after every run; the pause now only follows a wait that left the session idle with the operation unsettled.
