# MCP Server Example

This example demonstrates how to use `WebStandardStreamableHTTPServerTransport` to create an unauthenticated stateless MCP server.

In this example we do not use the `agents` package, but instead use the `@modelcontextprotocol/sdk` package directly to create an MCP server that "just works" on Cloudflare Workers.

This is THE simplest way to get started with MCP on Cloudflare.

## Usage

```bash
npm install
npm run dev
```

## Testing

You can test the MCP server using the MCP Inspector or any MCP client that supports the `streamable-http` transport.

## Adding State

To create a stateful MCP server, you can use an `Agent` to keep the state of the session/transport. See the [`mcp-elicitation`](../mcp-elicitation) example for more information.
