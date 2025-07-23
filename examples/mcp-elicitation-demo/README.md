# MCP Elicitation Demo

This is a MCP client-server example that shows how to use elicitation support using the Agents SDK.

- **Full MCP compliance** with https://modelcontextprotocol.io/specification/draft/client/elicitation

### MCP Server (`McpServerAgent`)

```typescript
export class McpServerAgent extends McpAgent<Env, { counter: number }, {}> {
  server = new McpServer({
    name: "Elicitation Demo Server",
    version: "1.0.0"
  }) as any;

  initialState = { counter: 0 };

  async init() {
    this.server.tool(
      "increment-counter",
      "Increment the counter with user confirmation",
      {
        amount: z.number().describe("Amount to increment by").default(1)
      },
      async ({ amount }: { amount: number }) => {
        const confirmation = await this.elicitInput({
          message: `Are you sure you want to increment the counter by ${amount}?`,
          requestedSchema: {
            type: "object",
            properties: {
              confirmed: {
                type: "boolean",
                title: "Confirm increment",
                description: "Check to confirm the increment"
              }
            },
            required: ["confirmed"]
          }
        });

        if (
          confirmation.action === "accept" &&
          confirmation.content?.confirmed
        ) {
          this.setState({ counter: this.state.counter + amount });
          return {
            content: [
              {
                type: "text",
                text: `Counter incremented by ${amount}. New value: ${this.state.counter}`
              }
            ]
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: "Counter increment cancelled."
              }
            ]
          };
        }
      }
    );
  }
}
```

### We support all three actions

- **Accept**: `{ "action": "accept", "content": { "email": "...", "role": "..." } }`
- **Decline**: `{ "action": "decline" }`
- **Cancel**: `{ "action": "cancel" }`

## Getting Started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the development server:

   ```bash
   npm start
   ```

3. Open your browser (typically http://localhost:5173/)

4. The demo auto-connects to the local MCP server

5. Try the elicitation tools:
   - **Increment Counter**: Click to see boolean confirmation elicitation
   - **Create User**: Click to see complex form elicitation

## How the elicitation actually works in this demo

1. User action – e.g. clicks “Create User”.
2. Server (McpServerAgent) calls elicitInput() → sends elicitation/create.
3. Client receives the request and shows the form modal.
4. User fills the form and clicks Accept, Decline, or Cancel.
5. Client returns an MCP‑compliant response.
6. Server continues execution based on the response.
