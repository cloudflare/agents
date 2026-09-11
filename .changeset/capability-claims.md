---
"agents": patch
---

Lifecycle capabilities declare how they claim traffic with `claims: "selective" | "catch-all"` instead of hosts passing `{ fallback: true }` to `lifecycle.use()`. A catch-all always dispatches last, whenever it was installed, and Lifecycle refuses to install a second one. `WebSockets` declares itself a catch-all, so hosts no longer need to remember the flag. `LifecycleUseOptions` is removed.
