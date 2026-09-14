import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { withX402, type X402Config } from "agents/payments/x402";
import { withX402 as withMcpX402 } from "agents/payments/x402/mcp";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader
} from "@x402/core/http";
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
    if (url.pathname === "/") {
      return Response.json({
        message: "One paid function, exposed over HTTP and MCP",
        http: "POST /square with { number: 5 }",
        mcp: "/mcp — call the square tool",
        price: "0.01 USDC on Base Sepolia"
      });
    }
    if (url.pathname !== "/square" && url.pathname !== "/mcp") {
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
        url: new URL("/square", url).href,
        description: "Square a number",
        mimeType: "application/json"
      }
    };

    if (url.pathname === "/mcp") {
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

    if (request.method !== "POST") {
      return new Response("Use POST", {
        status: 405,
        headers: { Allow: "POST" }
      });
    }
    const parsed = inputSchema.safeParse(
      await request.json().catch(() => undefined)
    );
    if (!parsed.success) {
      return Response.json(
        { error: "Expected { number: number }" },
        { status: 400 }
      );
    }
    const signature = request.headers.get("PAYMENT-SIGNATURE");
    let payment;
    try {
      payment = signature ? decodePaymentSignatureHeader(signature) : undefined;
    } catch {
      return Response.json(
        { error: "Invalid PAYMENT-SIGNATURE" },
        { status: 400 }
      );
    }

    const paidSquare = withX402(square, config);
    const outcome = await paidSquare(parsed.data, payment);
    if (outcome.status === "payment-required") {
      return Response.json(outcome.paymentRequired, {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader(
            outcome.paymentRequired
          )
        }
      });
    }
    if (outcome.status === "settlement-failed") {
      // Execution has run. Do not issue another challenge and automatically retry it.
      return Response.json(
        { error: "Payment settlement failed" },
        { status: 502 }
      );
    }
    return Response.json(outcome.result, {
      headers: {
        "PAYMENT-RESPONSE": encodePaymentResponseHeader(outcome.settlement)
      }
    });
  }
} satisfies ExportedHandler<Env>;
