import { Agent, getAgentByName, type Connection, type WSMessage } from "agents";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { withX402, withX402Client, type X402Config } from "agents/x402";
import { z } from "zod";
import type { PaymentRequirements } from "x402/types";
import { privateKeyToAccount } from "viem/accounts";
import ui from "./ui";

export class PayAgent extends Agent<Env> {
  confirmations: Record<string, (res: boolean) => void> = {};
  x402Client?: ReturnType<typeof withX402Client>;

  async onPaymentRequired(paymentRequirements: PaymentRequirements[]) {
    const confirmationId = crypto.randomUUID().slice(0, 4);

    this.broadcast(
      JSON.stringify({
        type: "payment_required",
        confirmationId,
        requirements: paymentRequirements
      })
    );

    const prom = new Promise<boolean>((res) => {
      this.confirmations[confirmationId] = res;
    });
    return await prom;
  }

  async onStart() {
    const account = privateKeyToAccount(
      process.env.CLIENT_TEST_PK as `0x${string}`
    );
    console.log("Agent will pay from this address:", account.address);

    const { id } = await this.mcp.connect("http://localhost:8787/mcp");

    // Build the x402 MCP client
    this.x402Client = withX402Client(this.mcp.mcpConnections[id].client, {
      network: "base-sepolia",
      account
    });
  }

  async onMessage(conn: Connection, message: WSMessage) {
    if (typeof message === "string") {
      try {
        const parsed = JSON.parse(message as string);
        if (parsed?.type) {
          switch (parsed.type) {
            case "confirm":
            case "cancel": {
              const confirmed = parsed.type === "confirm";
              this.confirmations[parsed.confirmationId]?.(confirmed);
              return;
            }
            case "echo":
            case "square": {
              const input =
                parsed.type === "square"
                  ? { number: parsed.number }
                  : { message: parsed.message };

              // The first parameter becomes the confirmation callback.
              // We can set it to `null` if we want the agent to pay automatically.
              const res = await this.x402Client!.callTool(
                this.onPaymentRequired.bind(this),
                {
                  name: parsed.type,
                  arguments: input
                }
              );

              conn.send(
                JSON.stringify({
                  event: res.isError ? "tool_error" : "tool_result",
                  tool: parsed.type,
                  output:
                    res.content[0]?.type === "text"
                      ? (res.content[0]?.text ?? "")
                      : ""
                })
              );
            }
          }
        }
      } catch (e) {
        console.error(e);
      }
    }
  }
}

// Create an MCP server with paid tools
const X402_CONFIG: X402Config = {
  network: "base-sepolia",
  recipient: process.env.MCP_ADDRESS as `0x${string}`,
  facilitator: { url: "https://x402.org/facilitator" } // Payment facilitator URL
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
      0.01, // USD
      { number: z.number() },
      {},
      async ({ number }) => {
        return { content: [{ type: "text", text: String(number ** 2) }] };
      }
    );

    // Free tool
    this.server.registerTool(
      "echo",
      {
        description: "Echo a message",
        inputSchema: { message: z.string() }
      },
      async ({ message }) => {
        return { content: [{ type: "text", text: message }] };
      }
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (request.url.endsWith("/mcp")) {
      return PayMCP.serve("/mcp").fetch(request, env, ctx);
    } else if (request.url.endsWith("/agent")) {
      const agent = await getAgentByName(env.PAY_AGENT, "1234");
      return agent.fetch(request);
    }

    return new Response(ui, { headers: { "Content-Type": "text/html" } });
  }
};
