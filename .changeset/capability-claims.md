---
"agents": patch
---

Lifecycle capabilities declare how they claim traffic with `claims: "selective" | "catch-all"` instead of hosts passing `{ fallback: true }` to `lifecycle.use()`. A catch-all always dispatches last, whenever it was installed. Catch-alls are unique per dispatch hook, so one for `onRequest` and one for `onWebSocketUpgrade` coexist while a second for the same hook is refused. `WebSockets` declares itself a catch-all for upgrades and never declines one: without `handlers` it still accepts and tracks connections; handlers only add behavior on connect, message, close and error. `LifecycleUseOptions` is removed.
