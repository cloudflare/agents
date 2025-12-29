import { Hono } from "hono";
import { Agent, getAgentByName } from "agents";
import { wrapFetchWithPayment } from "x402-fetch";
import { paymentMiddleware } from "x402-hono";
import { env } from "cloudflare:workers";

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
    this.fetchWithPay = wrapFetchWithPayment(fetch, agentAccount);
  }
}

const app = new Hono();

// Configure the middleware.
// Only gate the `protected-route` endpoint, everything else we keep free.
app.use(
  paymentMiddleware(
    process.env.SERVER_ADDRESS as `0x${string}`, // our server wallet address
    {
      "/protected-route": {
        price: "$0.10",
        network: "base-sepolia",
        config: {
          description: "Access to premium content"
        }
      }
    },
    { url: "https://x402.org/facilitator" } // Payment facilitator URL
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
