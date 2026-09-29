---
"agents": minor
"@cloudflare/think": patch
---

Start the lifecycle before an `async` Agent or Think method runs over native Durable Object RPC on a cold instance, so `onStart` has run and Think's session, messages and workspace are ready. Synchronous methods and methods inherited from `Agent` are unchanged. Adds `lifecycle.isStarted()`, and concurrent `lifecycle.start()` callers now share one in-flight startup and all see its result.

Breaking: startup resolves the object's name, so an Agent addressed with `newUniqueId()` or `idFromString()` now fails its first `async` RPC with the lifecycle's addressing error instead of serving the call against uninitialized state. Address Agents by name with `getAgentByName()`, `getByName()`, or `idFromName()`.
