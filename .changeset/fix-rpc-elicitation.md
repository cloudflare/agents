---
"agents": patch
---

Fix `elicitInput()` hanging on RPC transport by intercepting elicitation responses in `handleMcpMessage()` and adding `awaitPendingResponse()` to `RPCServerTransport`
