---
"agents": patch
"@cloudflare/think": patch
---

Initialize Agent and Think instances before native Durable Object RPC methods execute on a cold instance. Native RPC now performs normal PartyServer startup, so Agents addressed with `newUniqueId()` or `idFromString()` must first be bootstrapped with `setName()`; prefer name-based addressing with `idFromName()` or `getAgentByName()`.
