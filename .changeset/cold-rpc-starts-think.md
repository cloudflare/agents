---
"agents": minor
"@cloudflare/think": patch
---

Native RPC calls to async Agent and Think methods now start lifecycle initialization first; address Agents by name because raw IDs from `newUniqueId()` and `idFromString()` now fail their first async RPC. See [Lifecycle](https://github.com/cloudflare/agents/blob/main/docs/agents/lifecycle.md).
