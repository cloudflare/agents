---
"agents": patch
---

Re-arm the Durable Object alarm on startup when jobs are pending and no alarm is set, so work no longer waits for the next push after the platform drops a failing alarm or user code deletes it.
