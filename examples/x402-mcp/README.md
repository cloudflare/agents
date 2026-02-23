# x402 MCP — Paid Tools

Paid MCP tools using the [x402 payment protocol](https://x402.org). Includes both a server (`PayMCP`) with free and paid tools, and a client agent (`PayAgent`) that handles the payment confirmation flow — all in one Worker.

## What it demonstrates

- **`withX402(server, config)`** — wrapping an MCP server to add `paidTool()` for tools that cost money
- **`withX402Client(client, config)`** — wrapping an MCP client to handle payment flows automatically
- **`paidTool()`** — registering a tool with a USD price
- **`@callable`** — the client agent exposes `callTool` and `resolvePayment` as callable methods
- **`useAgent` + `agent.call()`** — the React frontend connects via WebSocket and calls agent methods directly
- **Payment confirmation flow** — paid tools trigger a modal in the UI; the user confirms before the agent signs the payment

## Running

Copy the environment file and fill in your keys:

```sh
cp .env.example .env
```

You need:

- `MCP_ADDRESS` — an Ethereum address to receive payments (Base Sepolia testnet)
- `CLIENT_TEST_PK` — a private key for signing payments (test key only)

Then:

```sh
npm install
npm start
```

Try the free **echo** tool and the paid **square** tool ($0.01) — the payment modal appears when calling paid tools.

## How it works

### Server: creating paid tools

```typescript
import { withX402, type X402Config } from "agents/x402";

const server = withX402(new McpServer({ name: "PayMCP", version: "1.0.0" }), {
  network: "eip155:84532",
  recipient: "0x...",
  facilitator: { url: "https://x402.org/facilitator" }
});

server.paidTool(
  "square",
  "Squares a number",
  0.01,
  { number: z.number() },
  {},
  async ({ number }) => ({
    content: [{ type: "text", text: String(number ** 2) }]
  })
);
```

### Client agent: calling paid tools

```typescript
import { withX402Client } from "agents/x402";

export class PayAgent extends Agent<Env> {
  @callable()
  async callTool(toolName: string, args: Record<string, unknown>) {
    const res = await this.x402Client.callTool(
      this.requestPaymentConfirmation.bind(this),
      { name: toolName, arguments: args }
    );
    return { text: res.content[0]?.text, isError: res.isError };
  }

  @callable()
  resolvePayment(confirmationId: string, confirmed: boolean) {
    this.pendingPayments[confirmationId]?.(confirmed);
  }
}
```

### React frontend

```typescript
const agent = useAgent({ agent: "pay-agent", name: sessionId });

const result = await agent.call("callTool", ["square", { number: 5 }]);
```

### x402 MCP transport spec

This follows the [x402 MCP transport specification](https://github.com/coinbase/x402/blob/main/specs/transports/mcp.md):

1. **402 error** — server returns JSON-RPC error with `code: 402` and `PaymentRequirementsResponse`
2. **Payment payload** — client retries with payment in `_meta["x402/payment"]`
3. **Settlement** — server confirms in `_meta["x402/payment-response"]`

## Related examples

- [`mcp`](../mcp/) — stateful MCP server (no payments)
- [`mcp-client`](../mcp-client/) — connecting to MCP servers as a client
