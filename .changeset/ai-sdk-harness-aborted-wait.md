---
"agents": patch
---

`AiSdkHarness`: `session.wait(operationId, signal)` now rejects straight away when `signal` is already aborted, instead of staying pending until the operation settles.
