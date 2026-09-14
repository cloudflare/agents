# Paid functions over HTTP and MCP

A paid `square` operation exposed over HTTP and MCP SDK v2, using a small function wrapper and an upstream x402 resource server. This example demonstrates the proposed `agents/payments/x402` APIs. It uses USDC on Base Sepolia and costs $0.01 per successful call.

There are no client/server factories, instance modifications, or decorators. The operation is an ordinary function. The HTTP route maps its payment outcome to a response; the MCP adapter handles MCP metadata and tool results.

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
pnpm call:http
pnpm call:mcp
```

Both commands call `square(5)` and ask before signing a payment. The client allows only Base Sepolia USDC, checks a 0.10 USDC per-payment cap after selection, and retries once. The receiving Worker needs no wallet private key.

To inspect the unpaid HTTP challenge without paying:

```sh
curl -i http://localhost:8787/square \
  -H 'Content-Type: application/json' \
  -d '{"number":5}'
```

## Wrap an ordinary function

Configure and initialize an upstream `x402ResourceServer`, register its payment schemes, and build the requirements once. See [src/index.ts](./src/index.ts) for the EVM setup.

```ts
import { withX402 } from "agents/payments/x402";

const config = {
  server: resourceServer,
  accepts: await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network: "eip155:84532",
    payTo: receivingAddress,
    price: "$0.01"
  }),
  resource: { url: "https://example.com/square" }
};

const paidSquare = withX402(
  async ({ number }: { number: number }) => ({ value: number ** 2 }),
  config
);

const outcome = await paidSquare({ number: 5 }, paymentPayload);
```

The input and output can be any types. The wrapper does not depend on MCP, HTTP, AI SDK, or a schema library. For a tool framework, wrap the operation behind its execute callback and translate the outcome at that framework's boundary.

`withX402(handler, config)` returns a function taking `(input, payment?)`. `config` contains an initialized upstream resource `server`, nonempty `accepts`, and `resource` metadata. The result is one of:

| Status              | Fields                 | Meaning                                                       |
| ------------------- | ---------------------- | ------------------------------------------------------------- |
| `payment-required`  | `paymentRequired`      | Missing or invalid payment; the handler did not run.          |
| `success`           | `result`, `settlement` | Verification, execution, and settlement succeeded.            |
| `settlement-failed` | `settlement`           | Execution ran, but settlement failed. The result is withheld. |

Handler and facilitator exceptions propagate. A handler exception prevents settlement. Settlement failure never triggers an automatic retry or a new challenge.

Verification, execution, and on-chain settlement are separate steps. Use idempotent operations: a valid authorization can still fail at settlement, and this wrapper provides neither a durable execution ledger nor exactly-once execution.

## Wrap an MCP tool callback

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

This adapter uses the same generic payment executor. It passes through the SDK v2 callback's arguments and context, accepts a payment object at `_meta["x402/payment"]`, and returns settlement receipts at `_meta["x402/payment-response"]`. Challenges use upstream x402's `isError` tool result with `PaymentRequired` in `structuredContent` and the text content.

Tool registration, schemas, descriptions, and annotations stay with `server.registerTool`. Free tools use their normal callback. Tool errors and intermediate `input_required` results pass through without settlement. Tools without an input schema use `withX402<undefined>` and receive the normal SDK v2 context.

The client in [src/client.ts](./src/client.ts) owns its ordinary MCP connection and uses upstream `x402Client` to sign the selected requirement. Wallets, approval, and spending policy belong to the application.

## Migrate the legacy wrappers

The `withX402` and `withX402Client` functions in `agents/x402` are deprecated and feature-frozen, like `McpAgent`. They remain available for compatibility and security fixes.

- Replace `withX402(server, config).paidTool(...)` with `server.registerTool(...)` and a callback wrapped by `withX402` from `agents/payments/x402/mcp`. Use an MCP SDK v2 server served by `createMcpHandler` from `agents/mcp/server`.
- Create the upstream resource server and payment requirements explicitly. The signer, facilitator, network, recipient, and spending policy remain visible at the application boundary.
- Replace `withX402Client` with an ordinary MCP SDK v2 `Client` and upstream `x402Client`, as shown in the client script. Preserve the selected-payment cap check and explicit approval before signing.

Move clients and endpoints together: the legacy wrapper uses base64 payment metadata and its own challenge format; the new wrapper uses upstream x402's object metadata and structured challenges. Keep the existing `McpAgent` endpoint alongside the new stateless endpoint while clients transition and old sessions drain.

The existing [`x402-mcp`](../../x402-mcp/) example remains available for the legacy API. Both integrations use x402 protocol v2; the deprecated server dependency is MCP SDK v1.
