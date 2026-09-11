---
"agents": patch
---

Lifecycle capabilities declare how they claim traffic with `claims: "selective" | "catch-all"` instead of hosts passing `{ fallback: true }` to `lifecycle.use()`. A catch-all always dispatches last, whenever it was installed, and Lifecycle refuses to install a second one. `WebSockets` declares itself a catch-all, so hosts no longer need to remember the flag. It now never declines an upgrade: without `handlers` it still accepts and tracks connections (handlers only add behavior on connect, message, close and error), and a `?__agents_rpc=capnweb` upgrade without `callables` gets a clear 404 from the capability instead of Lifecycle's generic one. `LifecycleUseOptions` is removed.
