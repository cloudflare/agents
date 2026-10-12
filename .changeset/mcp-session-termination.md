---
"agents": patch
---

`McpAgent` now answers requests for a session ended with `DELETE` with 404 straight away, instead of serving it until deferred teardown runs, and `createMcpHandler` rejects a Legacy request whose factory returns an instance still serving another request without closing that instance. See [Transport](https://developers.cloudflare.com/agents/model-context-protocol/transport/).
