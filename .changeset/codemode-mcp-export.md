---
"@cloudflare/codemode": patch
---

Add `@cloudflare/codemode/mcp` barrel export with two functions:

- `codeMcpServer(server, executor)` — wraps an MCP server with a single `code` tool where each upstream tool becomes a typed `codemode.*` method
- `openApiMcpServer({ spec, executor, request })` — creates `search` + `execute` MCP tools from an OpenAPI spec with host-side request proxying and automatic `$ref` resolution
