# McpAgent demo

A minimal example showing an `McpAgent` running in Wrangler, being accessed from the [MCP Inspector](https://github.com/modelcontextprotocol/inspector).

## Instruction

```sh
npm install
npm start
```

This will start a stateful MCP server on `http://localhost:5174/mcp` and open the MCP inspector in your browser.

Set your **Transport Type** to **Streamable HTTP** and your **URL** to `http://localhost:5174/mcp`, then click **Connect**. You should see the following:

![Image](https://github.com/user-attachments/assets/ef31b754-755d-4022-9549-382854a19f77)

Inside your `McpAgent`'s `init()` method, you can define resources, tools, etc:

```ts
export class MyMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "Demo",
    version: "1.0.0"
  });

  async init() {
    this.server.resource("counter", "mcp://resource/counter", (uri) => {
      // ...
    });

    this.server.registerTool(
      "add",
      {
        description: "Add to the counter, stored in the MCP",
        inputSchema: { a: z.number() }
      },
      async ({ a }) => {
        // add your logic here
      }
    );
  }
}
```
