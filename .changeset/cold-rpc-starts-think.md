---
"agents": patch
"@cloudflare/think": patch
---

Initialize Agent and Think instances before native Durable Object RPC methods execute on a cold instance. Native RPC now runs normal lifecycle startup, which resolves the object's name, so Agents addressed with `newUniqueId()` or `idFromString()` fail with the lifecycle's addressing error instead of serving a call against uninitialized state. Address Agents by name with `getAgentByName()`, `getByName()`, or `idFromName()`.
