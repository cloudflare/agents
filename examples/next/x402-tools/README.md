# Paid MCP tools with a generic x402 core

A paid `square` tool served with MCP SDK v2. The payment flow has two layers:

- `agents/payments/x402` verifies, executes, and settles any async function without depending on MCP, HTTP, a schema library, or an AI SDK.
- `agents/payments/x402/mcp` is a thin adapter that maps MCP callback arguments, payment metadata, challenges, and receipts onto that generic core.

The example uses the MCP adapter. It has no client/server factories, instance modifications, or decorators. It uses USDC on Base Sepolia and costs $0.01 per successful call.

## Run locally

From the repository root:

```sh
pnpm install
pnpm run build
cd examples/next/x402-tools
cp .dev.vars.example .dev.vars
cp .env.example .env
```

Set `PAY_TO` in `.dev.vars` to your receiving address. Set `CLIENT_TEST_PK` in `.env` to a test wallet private key with Base Sepolia USDC and enough gas. Run `pnpm dev`.

In another terminal in this directory:

```sh
pnpm call
```

The client calls `square(5)`, receives the MCP payment challenge, and asks before signing. It allows only Base Sepolia USDC, checks a 0.10 USDC per-payment cap against x402's selected requirement, and retries once. The receiving Worker needs no wallet private key.

## Generic payment core

Configure and initialize an upstream `x402ResourceServer`, register its payment schemes, and build the requirements once. The generic wrapper accepts an ordinary function:

```ts
import { withX402 } from "agents/payments/x402";

const paidSquare = withX402(
  async ({ number }: { number: number }) => ({ value: number ** 2 }),
  {
    server: resourceServer,
    accepts: await resourceServer.buildPaymentRequirements({
      scheme: "exact",
      network: "eip155:84532",
      payTo: receivingAddress,
      price: "$0.01"
    }),
    resource: { url: "https://example.com/mcp#square" }
  }
);

const outcome = await paidSquare({ number: 5 }, paymentPayload);
```

`withX402(handler, config)` returns a function taking `(input, payment?)`. Its input and output can be any types. The result is one of:

| Status              | Fields                 | Meaning                                                       |
| ------------------- | ---------------------- | ------------------------------------------------------------- |
| `payment-required`  | `paymentRequired`      | Missing or invalid payment; the handler did not run.          |
| `success`           | `result`, `settlement` | Verification, execution, and settlement succeeded.            |
| `settlement-failed` | `settlement`           | Execution ran, but settlement failed. The result is withheld. |

Handler and facilitator exceptions propagate. A handler exception prevents settlement. Settlement failure never triggers an automatic retry or a new challenge.

Verification, execution, and on-chain settlement are separate steps. Use idempotent operations: a valid authorization can still fail at settlement, and this wrapper provides neither a durable execution ledger nor exactly-once execution.

## MCP adapter

Register tools normally and wrap only callbacks that require payment:

```ts
import { withX402 } from "agents/payments/x402/mcp";

server.registerTool(
  "square",
  {
    description: "Square a number. Costs 0.01 USDC.",
    inputSchema
  },
  withX402<typeof inputSchema>(
    async ({ number }) => ({
      content: [{ type: "text", text: String(number ** 2) }]
    }),
    config
  )
);
```

The adapter passes the SDK v2 callback's arguments and context to the generic core. It accepts a payment object at `_meta["x402/payment"]` and returns settlement receipts at `_meta["x402/payment-response"]`. Challenges use upstream x402's `PaymentRequired` in `structuredContent`.

Tool registration, schemas, descriptions, and annotations stay with `server.registerTool`. Free tools use their normal callback. Tool errors and intermediate `input_required` results pass through without settlement. Tools without an input schema use `withX402<undefined>` and receive the normal SDK v2 context.

The client in [src/client.ts](./src/client.ts) owns its ordinary MCP connection and uses upstream `x402Client` to sign the selected requirement. Wallets, approval, and spending policy belong to the application.

## Migrate the legacy wrappers

The `withX402` and `withX402Client` functions in `agents/x402` are deprecated and feature-frozen, like `McpAgent`. They remain available for compatibility and security fixes.

- Replace `withX402(server, config).paidTool(...)` with `server.registerTool(...)` and a callback wrapped by `withX402` from `agents/payments/x402/mcp`. Use an MCP SDK v2 server served by `createMcpHandler` from `agents/mcp/server`.
- Create the upstream resource server and payment requirements explicitly. The signer, facilitator, network, recipient, and spending policy remain visible at the application boundary.
- Replace `withX402Client` with an ordinary MCP SDK v2 `Client` and upstream `x402Client`, as shown in the client script. Preserve the selected-payment cap check and explicit approval before signing.

Move clients and endpoints together: the legacy wrapper uses base64 payment metadata and its own challenge format; the new wrapper uses upstream x402's object metadata and structured challenges. Keep the existing `McpAgent` endpoint alongside the new stateless endpoint while clients transition and old sessions drain.

The existing [`x402-mcp`](../../x402-mcp/) example remains available for the legacy API. Both integrations use x402 protocol v2; the deprecated server dependency is MCP SDK v1.
