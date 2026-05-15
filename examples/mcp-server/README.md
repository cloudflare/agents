# MCP Server Example (Raw Transport)

This example demonstrates how to create an unauthenticated stateless MCP server using `WebStandardStreamableHTTPServerTransport` from the `@modelcontextprotocol/sdk` directly, **without** the Agents SDK helpers.

This gives you full control over the transport layer. If you want a simpler approach, see [`mcp-worker`](../mcp-worker) which uses `createMcpHandler()` from the Agents SDK.

## Usage

```bash
npm install
npm run dev
```

## Testing

You can test the MCP server using the MCP Inspector or any MCP client that supports the `streamable-http` transport.

## Adding State

To create a stateful MCP server, use `McpAgent` with a Durable Object. See the [`mcp`](../mcp) example for a stateful server, or [`mcp-elicitation`](../mcp-elicitation) for stateful sessions with user input elicitation.
