---
"agents": patch
---

Prevent MCP Streamable HTTP result responses from crossing between concurrent
POST streams when a reused session receives duplicate in-flight JSON-RPC
request ids. Responses now prefer the live connection that originated their
request and reject ambiguous routing when no origin can safely disambiguate.

Completion tracking for batched POST streams is now scoped per stream so an id
collision on another POST cannot prevent the original stream from closing.
