# WebMCP Adapter

> **WARNING: EXPERIMENTAL.** This example uses `agents/experimental/webmcp` which is under active development and **will break** between releases. Google's WebMCP API (`navigator.modelContext`) is still in early preview.

Bridges tools registered on an `McpAgent` to Chrome's native `navigator.modelContext` API using the experimental WebMCP adapter.

## What it demonstrates

- **`registerWebMcp()`** — one-line adapter that discovers MCP tools and registers them with Chrome's WebMCP
- **Feature detection** — graceful fallback when `navigator.modelContext` is unavailable
- **Dynamic sync** — listens for `tools/list_changed` notifications and re-syncs automatically
- **McpAgent tools** — same `McpAgent` server as the `mcp` example, with `add`, `greet`, and `get_counter` tools

## Running

```sh
npm install
npm start
```

Open in Chrome Canary with `#enable-webmcp-testing` and `#enable-experimental-web-platform-features` enabled at `chrome://flags` to see full WebMCP integration. On other browsers, the adapter detects the missing API and shows a status message.

## How it works

The server defines tools using `McpAgent` as usual:

```typescript
export class MyMCP extends McpAgent<Env, State, {}> {
  server = new McpServer({ name: "WebMCP Demo", version: "1.0.0" });

  async init() {
    this.server.registerTool(
      "greet",
      {
        description: "Greet someone by name",
        inputSchema: { name: z.string() }
      },
      async ({ name }) => ({
        content: [{ type: "text", text: `Hello, ${name}!` }]
      })
    );
  }
}

export default MyMCP.serve("/mcp", { binding: "MyMCP" });
```

The client uses the adapter to bridge those tools to Chrome's WebMCP:

```typescript
import { registerWebMcp } from "agents/experimental/webmcp";

const handle = await registerWebMcp({ url: "/mcp" });
console.log("Registered tools:", handle.tools);

// Clean up when done
handle.dispose();
```

The adapter:

1. Connects to the `/mcp` endpoint via MCP Streamable HTTP
2. Calls `tools/list` to discover all registered tools
3. Registers each tool with `navigator.modelContext.registerTool()`
4. Relays tool execution calls from Chrome's agent back to the MCP server
5. Listens for `tools/list_changed` to dynamically sync

## Related examples

- [`mcp`](../mcp/) — stateful MCP server with built-in tool tester UI
- [`mcp-client`](../mcp-client/) — connecting to MCP servers as a client
