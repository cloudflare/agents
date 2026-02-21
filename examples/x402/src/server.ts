import { Hono } from "hono";
import { Agent, callable, routeAgentRequest } from "agents";
import { wrapFetchWithPayment } from "@x402/fetch";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { x402Client } from "@x402/core/client";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme as registerClientEvmScheme } from "@x402/evm/exact/client";
import { registerExactEvmScheme as registerServerEvmScheme } from "@x402/evm/exact/server";
import { privateKeyToAccount } from "viem/accounts";

export class PayAgent extends Agent<Env> {
  fetchWithPay?: ReturnType<typeof wrapFetchWithPayment>;

  onStart() {
    const pk = process.env.CLIENT_TEST_PK;
    if (!pk) {
      console.warn(
        "CLIENT_TEST_PK not set — copy .env.example to .env and add a test private key"
      );
      return;
    }

    const account = privateKeyToAccount(pk as `0x${string}`);
    console.log("Agent will pay from:", account.address);

    const client = new x402Client();
    registerClientEvmScheme(client, { signer: account });
    this.fetchWithPay = wrapFetchWithPayment(fetch, client);
  }

  @callable()
  async fetchProtectedRoute() {
    if (!this.fetchWithPay) {
      return {
        text: "Agent not ready — CLIENT_TEST_PK not configured",
        isError: true
      };
    }

    const paidUrl = "http://localhost:5173/protected-route";
    const res = await this.fetchWithPay(paidUrl, {});
    const data = await res.json();

    return {
      text: JSON.stringify(data, null, 2),
      isError: !res.ok
    };
  }
}

const app = new Hono<{ Bindings: Env }>();

const facilitatorClient = new HTTPFacilitatorClient({
  url: "https://x402.org/facilitator"
});
const resourceServer = new x402ResourceServer(facilitatorClient);
registerServerEvmScheme(resourceServer);

app.use(
  paymentMiddleware(
    {
      "GET /protected-route": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.10",
            network: "eip155:84532",
            payTo: process.env.SERVER_ADDRESS as `0x${string}`
          }
        ],
        description: "Access to premium content",
        mimeType: "application/json"
      }
    },
    resourceServer
  )
);

app.get("/protected-route", (c) => {
  return c.json({
    message: "This content is behind a paywall. Thanks for paying!"
  });
});

app.all("/agents/*", async (c) => {
  const res = await routeAgentRequest(c.req.raw, c.env);
  return res || c.json({ error: "Not found" }, 404);
});

export default app;
