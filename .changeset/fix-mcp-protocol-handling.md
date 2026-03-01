---
"agents": patch
---

MCP protocol handling improvements:

- **JSON-RPC error responses**: `RPCServerTransport.handle()` now returns a proper JSON-RPC `-32600 Invalid Request` error response for malformed messages instead of throwing an unhandled exception. This aligns with the JSON-RPC 2.0 spec requirement that servers respond with error objects.
- **McpAgent protocol message suppression**: `McpAgent` now overrides `shouldSendProtocolMessages()` to suppress `CF_AGENT_IDENTITY`, `CF_AGENT_STATE`, and `CF_AGENT_MCP_SERVERS` frames on MCP transport connections (detected via the `cf-mcp-method` header). Regular WebSocket connections to a hybrid McpAgent are unaffected.
- **CORS warning removed**: Removed the one-time warning about `Authorization` in `Access-Control-Allow-Headers` with wildcard origin. The warning was noisy and unhelpful — the combination is valid for non-credentialed requests and does not pose a real security risk.
