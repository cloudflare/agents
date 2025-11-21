# x402 MCP Example

This example demonstrates how to create paid MCP tools using the [x402 payment protocol](https://x402.org) with Cloudflare Agents.

## Overview

The example includes:

- **PayMCP**: An MCP server that exposes paid and free tools
- **PayAgent**: A client agent that calls these tools and handles payment confirmation flows

## x402 MCP Integration

This implementation follows the [x402 MCP transport specification](https://github.com/coinbase/x402/blob/main/specs/transports/mcp.md#payment-payload-transmission), which defines:

1. **Payment Required Signaling**: Server returns JSON-RPC error with `code: 402` and `PaymentRequirementsResponse`
2. **Payment Payload Transmission**: Client sends payment in `_meta["x402/payment"]`
3. **Settlement Response**: Server confirms payment in `_meta["x402/payment-response"]`

### Price Discovery Extension

In addition to the core x402 MCP spec, this implementation includes a **Agents extension** for price discovery:

```typescript
_meta: {
  "agents-x402/paymentRequired": true,  // Indicates tool requires payment
  "agents-x402/priceUSD": 0.01           // Pre-advertises price in USD
}
```

**Note**: The `agents-x402/` namespace is used (not `x402/`) because price pre-advertising is an extension beyond the official x402 MCP specification to allow for a nice user experience. The core spec only defines the reactive payment flow (call → 402 error → retry with payment).

## Usage

### Server Side: Creating Paid Tools

```typescript
import { withX402 } from "agents/x402";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const server = withX402(new McpServer({ name: "PayMCP", version: "1.0.0" }), {
  network: "base-sepolia",
  recipient: "0x...",
  facilitator: { url: "https://x402.org/facilitator" }
});

// Create a paid tool
server.paidTool(
  "square",
  "Squares a number",
  0.01, // Price in USD
  { number: z.number() },
  {}, // MCP annotations (readOnlyHint, etc.)
  async ({ number }) => {
    return { content: [{ type: "text", text: String(number ** 2) }] };
  }
);
```

### Client Side: Calling Paid Tools

```typescript
import { withX402Client } from "agents/x402";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(env.PRIVATE_KEY);

const x402Client = withX402Client(mcpClient, {
  network: "base-sepolia",
  account
});

// Call tool with payment confirmation callback
const result = await x402Client.callTool(
  async (requirements) => {
    // Show payment prompt to user
    return await userConfirmsPayment(requirements);
  },
  {
    name: "square",
    arguments: { number: 5 }
  }
);
```

## Environment Variables

```bash
# Server: Address to receive payments
MCP_ADDRESS=0x...

# Client: Private key for signing payments
CLIENT_TEST_PK=0x...
```

## Running the Example

```bash
npm install
npx wrangler dev
```

Then open http://localhost:8787 in your browser.
