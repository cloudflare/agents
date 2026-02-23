# Stateful MCP Server

A stateful MCP server using `McpAgent` backed by a Durable Object. State persists across requests — the built-in UI lets you call tools and read resources to see it in action.

## What it demonstrates

- **`McpAgent`** — the Agents SDK class for building MCP servers with persistent state
- **Tools** — registering an `add` tool that modifies the counter
- **Resources** — exposing the counter value as an MCP resource
- **State management** — `setState` and `onStateChanged` for durable state
- **Streamable HTTP transport** — the default transport for `McpAgent`

## Running

```sh
npm install
npm run dev
```

Open the browser to see the built-in tool tester. You can also connect with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) — set the transport to **Streamable HTTP** and URL to `http://localhost:5173/mcp`.

## How it works

The `McpAgent` class extends `Agent` with MCP protocol support. Define your tools and resources in the `init()` method:

```typescript
export class MyMCP extends McpAgent<Env, State, {}> {
  server = new McpServer({ name: "Demo", version: "1.0.0" });
  initialState: State = { counter: 1 };

  async init() {
    this.server.resource("counter", "mcp://resource/counter", (uri) => ({
      contents: [{ text: String(this.state.counter), uri: uri.href }]
    }));

    this.server.registerTool(
      "add",
      { description: "Add to the counter", inputSchema: { a: z.number() } },
      async ({ a }) => {
        this.setState({ ...this.state, counter: this.state.counter + a });
        return {
          content: [{ type: "text", text: `Total: ${this.state.counter}` }]
        };
      }
    );
  }
}

export default MyMCP.serve("/mcp", { binding: "MyMCP" });
```

## Related examples

- [`mcp-worker`](../mcp-worker/) — simplest stateless MCP server using `createMcpHandler`
- [`mcp-worker-authenticated`](../mcp-worker-authenticated/) — adding OAuth to an MCP server
- [`mcp-client`](../mcp-client/) — connecting to MCP servers as a client
