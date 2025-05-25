# McpAgent demo

A minimal example showing an `McpAgent` running in Wrangler, being accessed from the [MCP Inspector](https://github.com/modelcontextprotocol/inspector).

## Instructions

```sh
npm install
npm start
```

You should have the MCP running on http://localhost:8787/sse and your Agent on http://localhost:5174

Set your **Transport Type** to **SSE** and your **URL** to `http://localhost:8787/sse`, then click **Connect**. You should see the following:

![Image](https://github.com/user-attachments/assets/86ec7df4-71fd-40e9-b9f6-32f2f5e003e5)

Inside your `McpAgent`'s `async init()` method, you can use the MCP SDK to define resources, tools, etc:

```ts
export class MyMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "Demo",
    version: "1.0.0",
  });

  async init() {
    this.server.resource(`counter`, `mcp://resource/counter`, (uri) => {
      // ...
    });

    this.server.tool(
      "add",
      "Add two numbers together",
      { a: z.number(), b: z.number() },
      async ({ a, b }) => {
        // ...
      }
    );
  }
}
```
