# x402 HTTP Payments

HTTP payment gating using the [x402 protocol](https://x402.org) with Hono middleware. A `/protected-route` requires a $0.10 payment on Base Sepolia — an Agent with a test wallet pays automatically.

## What it demonstrates

- **`@x402/hono` middleware** — `paymentMiddleware()` gates any Hono route behind a price
- **`@x402/fetch`** — `wrapFetchWithPayment(fetch)` wraps `fetch` so the agent signs and pays automatically
- **`@x402/evm`** — EVM scheme registration for both client and server
- **`@callable`** — the agent exposes `fetchProtectedRoute` as a callable method
- **`useAgent` + `agent.call()`** — the React frontend triggers the paid fetch via WebSocket RPC

## Running

Copy the environment file and fill in your keys:

```sh
cp .env.example .env
```

You need:

- `SERVER_ADDRESS` — an Ethereum address to receive payments (Base Sepolia testnet)
- `CLIENT_TEST_PK` — a private key for signing payments (test key only, get test funds from https://faucet.circle.com/)

Then:

```sh
npm install
npm start
```

Press "Fetch & Pay" to have the agent access the protected route and automatically pay.

## How it works

### Server: gating a route

```typescript
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";

app.use(
  paymentMiddleware(
    {
      "GET /protected-route": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.10",
            network: "eip155:84532",
            payTo: process.env.SERVER_ADDRESS
          }
        ],
        description: "Access to premium content"
      }
    },
    resourceServer
  )
);

app.get("/protected-route", (c) => c.json({ message: "Thanks for paying!" }));
```

### Agent: paying automatically

```typescript
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";

export class PayAgent extends Agent<Env> {
  onStart() {
    const client = new x402Client();
    registerClientEvmScheme(client, { signer: account });
    this.fetchWithPay = wrapFetchWithPayment(fetch, client);
  }

  @callable()
  async fetchProtectedRoute() {
    const res = await this.fetchWithPay("/protected-route", {});
    return { text: await res.text(), isError: !res.ok };
  }
}
```

## Compared to x402-mcp

This example gates **HTTP endpoints** using `@x402/*` libraries directly. The [`x402-mcp`](../x402-mcp/) example gates **MCP tools** using the Agents SDK's `withX402()` / `withX402Client()` wrappers. Different protocols, different APIs.

## Related examples

- [`x402-mcp`](../x402-mcp/) — paid MCP tools using the Agents SDK's x402 integration
