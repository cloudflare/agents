import { Agent, callable, routeAgentRequest } from "agents";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import {
  withX402,
  withX402Client,
  type X402Config,
  type PaymentRequirements
} from "agents/x402";
import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";

// --- MCP Server with paid tools ---

const X402_CONFIG: X402Config = {
  network: "eip155:84532",
  recipient: process.env.MCP_ADDRESS as `0x${string}`,
  facilitator: { url: "https://x402.org/facilitator" }
};

export class PayMCP extends McpAgent<Env> {
  server = withX402(
    new McpServer({ name: "PayMCP", version: "1.0.0" }),
    X402_CONFIG
  );

  async init() {
    this.server.paidTool(
      "square",
      "Squares a number",
      0.01,
      { number: z.number() },
      {},
      async ({ number }) => ({
        content: [{ type: "text", text: String(number ** 2) }]
      })
    );

    this.server.registerTool(
      "echo",
      {
        description: "Echo a message",
        inputSchema: { message: z.string() }
      },
      async ({ message }) => ({
        content: [{ type: "text", text: message }]
      })
    );
  }
}

// --- Client agent that calls paid tools ---

export class PayAgent extends Agent<Env> {
  pendingPayments: Record<string, (confirmed: boolean) => void> = {};
  x402Client?: ReturnType<typeof withX402Client>;

  async onStart() {
    const pk = process.env.CLIENT_TEST_PK;
    if (!pk) {
      console.warn(
        "CLIENT_TEST_PK not set — copy .env.example to .env and add a test private key"
      );
      return;
    }

    const account = privateKeyToAccount(pk as `0x${string}`);

    const mcpUrl = `http://localhost:5173/mcp`;
    const { id } = await this.mcp.connect(mcpUrl);

    this.x402Client = withX402Client(this.mcp.mcpConnections[id].client, {
      network: "eip155:84532",
      account
    });
  }

  private async requestPaymentConfirmation(
    requirements: PaymentRequirements[]
  ): Promise<boolean> {
    const confirmationId = crypto.randomUUID().slice(0, 4);

    this.broadcast(
      JSON.stringify({
        type: "payment_required",
        confirmationId,
        requirements
      })
    );

    return new Promise<boolean>((resolve) => {
      this.pendingPayments[confirmationId] = resolve;
    });
  }

  @callable()
  async callTool(toolName: string, args: Record<string, unknown>) {
    if (!this.x402Client) {
      return { text: "Agent not ready", isError: true };
    }

    const res = await this.x402Client.callTool(
      this.requestPaymentConfirmation.bind(this),
      { name: toolName, arguments: args }
    );

    return {
      text:
        res.content[0]?.type === "text"
          ? (res.content[0]?.text ?? "")
          : JSON.stringify(res.content),
      isError: res.isError ?? false
    };
  }

  @callable()
  resolvePayment(confirmationId: string, confirmed: boolean) {
    this.pendingPayments[confirmationId]?.(confirmed);
    delete this.pendingPayments[confirmationId];
  }
}

// --- Routing ---

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      return PayMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response(null, { status: 404 })
    );
  }
};
