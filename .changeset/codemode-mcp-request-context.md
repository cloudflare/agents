---
"@cloudflare/codemode": patch
---

Pass the outer MCP tool-call context to `openApiMcpServer` request callbacks so server-to-client requests and notifications can be associated with the originating response stream.
