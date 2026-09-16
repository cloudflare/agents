import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import type { X402Config } from "agents/payments/x402";
import { withX402 as withMcpX402 } from "agents/payments/x402/mcp";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { z } from "zod";

const inputSchema = z.object({ number: z.number() });

// The operation has no HTTP, MCP, payment, or schema-library dependency.
async function square({ number }: { number: number }) {
  return { value: number ** 2 };
}

type PaymentSetup = Pick<X402Config, "server" | "accepts">;
let setupPromise: Promise<PaymentSetup> | undefined;
function getPayments(env: Env): Promise<PaymentSetup> {
  setupPromise ??= (async () => {
    const server = new x402ResourceServer(
      new HTTPFacilitatorClient({ url: env.FACILITATOR_URL })
    );
    registerExactEvmScheme(server);
    await server.initialize();
    const accepts = await server.buildPaymentRequirements({
      scheme: "exact",
      network: "eip155:84532",
      payTo: env.PAY_TO,
      price: "$0.01"
    });
    return { server, accepts };
  })().catch((error) => {
    setupPromise = undefined;
    throw error;
  });
  return setupPromise;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO)) {
      return Response.json(
        { error: "Set PAY_TO in .dev.vars to your receiving address" },
        { status: 503 }
      );
    }

    const config: X402Config = {
      ...(await getPayments(env)),
      resource: {
        url: `${new URL("/mcp", url).href}#square`,
        description: "Square a number",
        mimeType: "application/json"
      }
    };

    return createMcpHandler(() => {
      const server = new McpServer({ name: "Paid tools", version: "1.0.0" });
      server.registerTool(
        "square",
        { description: "Square a number. Costs 0.01 USDC.", inputSchema },
        withMcpX402<typeof inputSchema>(async (input) => {
          const result = await square(input);
          return {
            content: [{ type: "text", text: String(result.value) }],
            structuredContent: result
          };
        }, config)
      );
      return server;
    })(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
