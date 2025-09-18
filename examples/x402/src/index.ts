// Let's start by creating a Worker that serves a paid endpoint.
// We'll use Hono for the routing so we can use x402's middleware
// You can run this example with `npm run dev` and follow along!
import { Hono } from "hono";
import { paymentMiddleware } from "x402-hono";
import { privateKeyToAccount } from "viem/accounts"; // Used to handle wallet accounts
const app = new Hono<{ Bindings: Env }>();
export default app;

// We instantiate the wallet address where we want to receive payments
const TEST_SERVER_ACCOUNT = privateKeyToAccount(
  process.env.SERVER_TEST_PK as `0x${string}`
);
console.log("Server will receive payments here:", TEST_SERVER_ACCOUNT.address);

// Configure the middleware.
// Only gate the `protected-route` endpoint, everything else is free.
app.use(
  paymentMiddleware(
    TEST_SERVER_ACCOUNT.address,
    {
      "/protected-route": {
        price: "$0.10",
        network: "base-sepolia",
        config: {
          description: "Access to premium content"
        }
      }
    },
    {
      url: "https://x402.org/facilitator" // Facilitator URL for Base Sepolia testnet.
    }
  )
);

// This is paid endpoint handler we can implement as we please.
// The middleware already handles everything for us.
app.get("/protected-route", (c) => {
  return c.json({
    message: "This content is behind a paywall. Thanks for paying!"
  });
});

// Running the following will return a 402 status code.
`
$ curl http://localhost:8787/protected-route | jq
{
  "error": "X-PAYMENT header is required",
  "accepts": [
    {
      "scheme": "exact",
      "network": "base-sepolia",
      "maxAmountRequired": "100000",
      "resource": "http://localhost:8787/protected-route",
      "description": "Access to premium content",
      "mimeType": "application/json",
      "payTo": "0xFa75d8F07BA244c29cbdb32fD3093D759857072E",
      "maxTimeoutSeconds": 300,
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "outputSchema": {
        "input": {
          "type": "http",
          "method": "GET",
          "discoverable": true
        }
      },
      "extra": {
        "name": "USDC",
        "version": "2"
      }
    }
  ],
  "x402Version": 1
}
`;

// Let's create an Agent that can fetch the protected route and automatically pay.
// We're also instantiating a wallet from which the agent will pay. It must not be empty!
// You can get test credits for base-sepolia here: https://faucet.circle.com/
import { Agent, getAgentByName } from "agents";
import { wrapFetchWithPayment } from "x402-fetch";

export class PayAgent extends Agent<Env> {
  async onRequest() {
    const agentAccount = privateKeyToAccount(
      process.env.CLIENT_TEST_PK as `0x${string}`
    );
    console.log("Agent will pay from this address:", agentAccount.address);
    console.log("Trying to fetch Payed API");
    const fetchWithPay = wrapFetchWithPayment(fetch, agentAccount);
    return fetchWithPay("http://localhost:8787/protected-route", {});
  }

  async usePaidTool() {
    const agentAccount = privateKeyToAccount(
      process.env.CLIENT_TEST_PK as `0x${string}`
    );
    console.log("Agent will pay from this address:", agentAccount.address);
    this.mcp.enableX402Payments({
      network: "base-sepolia",
      account: agentAccount
    });

    const { id: serverId } = await this.mcp.connect(
      "http://localhost:8787/mcp"
    );
    const res = await this.mcp.callTool({
      serverId,
      name: "square",
      arguments: { number: 12 }
    });

    // Log result
    console.log("res", res);
    const text = (res as any)?.content?.[0]?.text ?? "";
    console.log("square(12) =>", text);
  }
}

// Let's add an endpoint to our Hono app for our agent
app.get("/agent", async (c) => {
  const agent = await getAgentByName(c.env.PAY_AGENT, "1234");
  return agent.fetch(c.req.raw);
});

// Now that we've equipped our agent with an x402 client, it can now
// access the paid endpiont for us. Trying to curl our Agent endpoint
// now returns our paywalled content!
`
$ curl http://localhost:8787/agent | jq
{
  "message": "This content is behind a paywall. Thanks for paying!"
}
`;
// You can check the transactions in the network here:
// https://base-sepolia.blockscout.com/address/<wallet-address>?tab=token_transfers

// Let's take it one step further now, and create an MCP server with paid tools.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent, withX402, type X402Config } from "agents/mcp";
import { z } from "zod";

const X402_CONFIG: X402Config = {
  network: "base-sepolia",
  recipient: TEST_SERVER_ACCOUNT.address,
  facilitator: {
    url: "https://x402.org/facilitator" // Facilitator URL for Base Sepolia testnet.
  }
};
export class PayMCP extends McpAgent<Env> {
  server = withX402(
    new McpServer({ name: "PayMCP", version: "1.0.0" }),
    X402_CONFIG
  );

  async init() {
    // Paid tool
    this.server.paidTool(
      "square",
      "Squares a number",
      0.01, // USD I think
      {
        number: z.number()
      },
      {},
      async ({ number }) => {
        return { content: [{ type: "text", text: String(number ** 2) }] };
      }
    );

    // Free tool
    this.server.tool(
      "echo",
      "Echo a message",
      {
        message: z.string()
      },
      async ({ message }, extra) => {
        console.log("Extra:", extra._meta);
        return { content: [{ type: "text", text: message }] };
      }
    );
  }
}

// Now let's add the MCP to our Hono app
app.use("/mcp", (c) => {
  return PayMCP.serve("/mcp", { binding: "PAY_MCP" }).fetch(
    c.req.raw,
    c.env,
    c.executionCtx
  );
});

app.use("/paid-tool", async (c) => {
  const agent = await getAgentByName(c.env.PAY_AGENT, "1234");
  await agent.usePaidTool();
  return c.json({
    message: "Paid tool used successfully"
  });
});
