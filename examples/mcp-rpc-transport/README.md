# MCP RPC Transport

An Agent calling an McpAgent within the same Worker using RPC transport -- no HTTP, no network overhead. Uses Workers AI so no API keys are needed.

## How to run

```bash
npm install && npm start
```

## What this demonstrates

The RPC transport connects an Agent to an McpAgent via Durable Object bindings. Both live in the same Worker. The Agent passes the DO namespace directly to `addMcpServer`:

```typescript
export class Chat extends AIChatAgent<Env> {
  async onStart() {
    await this.addMcpServer("my-mcp", this.env.MyMCP, {
      props: { userId: "demo-user-123", role: "admin" }
    });
  }
}
```

The McpAgent defines tools that become available to the chat:

```typescript
export class MyMCP extends McpAgent<Env, State, Props> {
  server = new McpServer({ name: "Demo", version: "1.0.0" });

  async init() {
    this.server.tool(
      "add",
      "Add to counter",
      { a: z.number() },
      async ({ a }) => {
        this.setState({ counter: this.state.counter + a });
        return {
          content: [{ type: "text", text: `Total: ${this.state.counter}` }]
        };
      }
    );
  }
}
```

Try asking the AI to add numbers to the counter or check who you are.

## Related

- [MCP Client](../mcp-client) -- connecting to remote MCP servers with OAuth
- [MCP Transports docs](../../docs/mcp-transports.md) -- all transport options
