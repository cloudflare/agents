# RPC Transport for MCP

Example showing an `Agent` calling an `McpAgent` within the same worker using a custom RPC transport.

## Why RPC Transport?

If your MCP server and your agent/client are both deployed to the Cloudflare developer platform, our RPC transport is the fastest way to connect them:

- **No network overhead** - Direct function calls instead of HTTP
- **Simpler** - No endpoints to configure, no connection management, no authentication.

This is very useful for internal applications. You can define `tools`, `prompts` and `resources` in your MCP server, expose that publically to your users, and also power your own `Agent` from the same `McpAgent`.

## How it works

Both the agent (MCP client) and MCP server can exist in the same Worker.

The MCP server is just a regular `McpAgent`:

```typescript
export class MyMCP extends McpAgent<Env, State, {}> {
  server = new McpServer({
    name: "Demo",
    version: "1.0.0"
  });

  async init() {
    this.server.tool(
      "add",
      "Add to the counter, stored in the MCP",
      { a: z.number() },
      async ({ a }) => {
        this.setState({ ...this.state, counter: this.state.counter + a });
        return {
          content: [
            {
              text: `Added ${a}, total is now ${this.state.counter}`,
              type: "text"
            }
          ]
        };
      }
    );
  }
}
```

The agent calls out to the MCP server using Cloudflare's RPC bindings:

```typescript
export class Chat extends AIChatAgent<Env> {
  async onStart(): Promise<void> {
    // Connect to MyMCP server via RPC
    await this.addRpcMcpServer("test-server", "MyMCP");
  }

  async onChatMessage(onFinish: StreamTextOnFinishCallback<ToolSet>) {
    // MCP tools are now available
    const allTools = this.mcp.getAITools();

    const result = streamText({
      model,
      tools: allTools
      // ...
    });
  }
}
```

## Instructions

1. Copy `.dev.vars.example` to `.dev.vars` and add your OpenAI API key
2. Run `npm install`
3. Run `npm start`
4. Open the UI in your browser

Try asking the AI to add numbers to the counter!

## More Info

Sevice bindings over RPC are commonly used in Workers to call out to other Cloudflare services. You can find out more [in the docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/).

The Model Context Protocol supports [pluggable transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports). The code for this custom RPC transport can be found [here](packages/agents/src/mcp/rpc.ts)
