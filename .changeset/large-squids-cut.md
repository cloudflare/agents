---
"agents": patch
---

MCP WorkerTransport accepts any supported protocol version in request headers and only rejects truly unsupported versions. This aligns with the move by MCP community to stateless transports and fixes an isse with 'mcp-protocol-version': '2025-11-25'
