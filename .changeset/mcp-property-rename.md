---
"@cloudflare/agents": major
---

Rename `server` property to `mcp` in MCP-related classes for better developer experience

## Changes

- **BREAKING**: Renamed `server` property to `mcp` in `McpAgent` class and related examples
- **BREAKING**: Renamed `mcp` property to `mcpClientManager` in `Agent` class to avoid naming conflicts
- Added backward compatibility support for `server` property in `McpAgent` with deprecation warning
- Updated all MCP examples to use the new `mcp` property naming convention
- Improved property naming consistency across the MCP implementation

## Migration

If you're using the `server` property in your `McpAgent` implementations, update your code:

```ts
// Before
export class MyMcpAgent extends McpAgent {
  server = new McpServer({...});
}

// After
export class MyMcpAgent extends McpAgent {
  mcp = new McpServer({...});
}
```

The `server` property is still supported for backward compatibility but will be removed in a future version.
