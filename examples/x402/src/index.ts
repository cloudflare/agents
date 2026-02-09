import { Hono } from "hono";
import { Agent, getAgentByName } from "agents";
import { env } from "cloudflare:workers";

// v2 x402 imports
import { wrapFetchWithPayment } from "@x402/fetch";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { x402Client } from "@x402/core/client";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme as registerClientEvmScheme } from "@x402/evm/exact/client";
import { registerExactEvmScheme as registerServerEvmScheme } from "@x402/evm/exact/server";

// This allows us to create a wallet from just a private key
// We'll use it for both the payer and receiver accounts
import { privateKeyToAccount } from "viem/accounts";

// We create an Agent that can fetch the protected route and automatically pay.
// We're also instantiating a wallet from which the agent will pay. It must not be empty!
// You can get test credits for base-sepolia here: https://faucet.circle.com/
export class PayAgent extends Agent<Env> {
  confirmations: Record<string, (res: boolean) => void> = {};
  squareMcpId?: string;
  fetchWithPay!: ReturnType<typeof wrapFetchWithPayment>;

  async onRequest(req: Request) {
    const url = new URL(req.url);
    console.log("Trying to fetch Payed API");

    // We use the x402 fetch to access our paid endpoint
    // Note: this could be any paid endpoint hosted on any server
    const paidUrl = new URL("/protected-route", url.origin).toString();
    return this.fetchWithPay(paidUrl, {});
  }

  onStart() {
    // We instantiate a wallet from which the agent will pay
    const pk = process.env.CLIENT_TEST_PK as `0x${string}`;
    const agentAccount = privateKeyToAccount(pk);
    console.log("Agent will pay from this address:", agentAccount.address);

    // Create v2 x402 payment client with EVM scheme support
    const client = new x402Client();
    registerClientEvmScheme(client, { signer: agentAccount });

    this.fetchWithPay = wrapFetchWithPayment(fetch, client);
  }
}

const app = new Hono();

// Create a v2 x402 resource server with EVM scheme support
const facilitatorClient = new HTTPFacilitatorClient({
  url: "https://x402.org/facilitator"
});
const resourceServer = new x402ResourceServer(facilitatorClient);
registerServerEvmScheme(resourceServer);

// Configure the middleware.
// Only gate the `protected-route` endpoint, everything else we keep free.
app.use(
  paymentMiddleware(
    {
      "GET /protected-route": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.10",
            network: "eip155:84532", // Base Sepolia (CAIP-2 format)
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

// Our paid endpoint will return some premium content.
app.get("/protected-route", (c) => {
  return c.json({
    message: "This content is behind a paywall. Thanks for paying!"
  });
});

// The agent will fetch our own protected route and automatically pay.
app.get("/agent", async (c) => {
  const agent = await getAgentByName(env.PAY_AGENT, "1234");
  return agent.fetch(c.req.raw);
});

export default app;
