# MCP Elicitation Demo

An MCP server that uses **elicitation** — the ability to request additional user input mid-tool-call. The `increase-counter` tool asks the user to confirm and specify an amount before modifying state.

## What it demonstrates

- **`this.elicitInput()`** — requesting structured user input during a tool call, built into `McpAgent`
- **JSON Schema for elicitation** — defining the shape of the data you need from the user
- **Stateful `McpAgent`** — counter state persists across requests via Durable Objects

## Running

```sh
npm install
npm start
```

Open the browser for connection instructions. Elicitation requires an MCP client that supports the `elicitation/create` protocol method — the browser UI cannot handle the interactive prompt. Connect from one of these instead:

- **MCP Inspector** — `npx @modelcontextprotocol/inspector`, set transport to **Streamable HTTP** and URL to `http://localhost:5173/mcp`
- **Claude Desktop / Cursor / Windsurf** — add as a remote MCP server at `http://localhost:5173/mcp`

## How it works

Inside a tool handler, call `this.elicitInput()` to pause execution and request structured input from the client:

```typescript
export class MyMCP extends McpAgent<Env, State, {}> {
  server = new McpServer({ name: "Elicitation Demo", version: "1.0.0" });
  initialState = { counter: 0 };

  async init() {
    this.server.registerTool("increase-counter", { ... }, async ({ confirm }) => {
      const result = await this.elicitInput({
        message: "By how much do you want to increase the counter?",
        requestedSchema: {
          type: "object",
          properties: {
            amount: { type: "number", title: "Amount" }
          },
          required: ["amount"]
        }
      });

      if (result.action === "accept" && result.content) {
        this.setState({ counter: this.state.counter + Number(result.content.amount) });
      }
    });
  }
}

export default MyMCP.serve("/mcp", { binding: "MyMCP" });
```

The MCP client receives the elicitation request, prompts the user, and sends the response back. The tool call resumes once the user responds.

## Related examples

- [`mcp`](../mcp/) — stateful MCP server without elicitation
- [`mcp-worker`](../mcp-worker/) — simplest stateless MCP server
