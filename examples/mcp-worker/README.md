# MCP Worker Example

This example demonstrates the simplest way to create an unauthenticated stateless MCP server using `createMcpHandler()` from the Agents SDK.

`createMcpHandler()` handles Streamable HTTP transport, CORS, session management, and error handling for you. If you need full control over the transport, see [`mcp-server`](../mcp-server) which uses the `@modelcontextprotocol/sdk` transport directly.

For a stateful MCP server with per-session state, see [`mcp`](../mcp) which uses `McpAgent` with Durable Objects.

## Usage

```bash
npm install
npm run dev
```

## Testing

You can test the MCP server using the MCP Inspector or any MCP client that supports the `streamable-http` transport.
