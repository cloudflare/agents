import type {
  McpServer,
  RegisteredTool,
  ToolCallback
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ToolAnnotations
} from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";
import z from "zod";

import { processPriceToAtomicAmount } from "x402/shared";
import { exact } from "x402/schemes";
import { useFacilitator } from "x402/verify";
import type { FacilitatorConfig, Network, PaymentPayload } from "x402/types";

export type X402Config = {
  network: Network;
  recipient: `0x${string}`;
  facilitator: FacilitatorConfig;
  version?: number;
};

export interface X402AugmentedServer {
  paidTool<Args extends ZodRawShape>(
    name: string,
    description: string,
    priceUSD: number,
    paramsSchema: Args,
    annotations: ToolAnnotations,
    cb: ToolCallback<Args>
  ): RegisteredTool;
}

export function withX402<T extends McpServer>(
  server: McpServer,
  cfg: X402Config
): T & X402AugmentedServer {
  const { verify, settle } = useFacilitator(cfg.facilitator);
  const x402Version = cfg.version ?? 1;

  function paidTool<Args extends ZodRawShape>(
    name: string,
    description: string,
    priceUSD: number,
    paramsSchema: Args,
    annotations: ToolAnnotations,
    cb: ToolCallback<Args>
  ): RegisteredTool {
    return server.tool(
      name,
      description,
      paramsSchema,
      { ...annotations, paymentHint: true },
      (async (args, extra) => {
        // Build PaymentRequirements for this call
        const atomic = processPriceToAtomicAmount(priceUSD, cfg.network);
        if ("error" in atomic) {
          const payload = { x402Version, error: "PRICE_COMPUTE_FAILED" };
          return {
            isError: true,
            _meta: { "x402.error": payload },
            content: [{ type: "text", text: JSON.stringify(payload) }]
          } as const;
        }
        const { maxAmountRequired, asset } = atomic;
        const requirements = {
          scheme: "exact" as const,
          network: cfg.network,
          maxAmountRequired,
          payTo: cfg.recipient,
          asset: asset.address,
          maxTimeoutSeconds: 300,
          resource: `mcp://tool/${name}`,
          mimeType: "application/json" as const,
          description,
          extra: "eip712" in asset ? asset.eip712 : undefined
        };

        // Get token either from MCP _meta or from header
        const headers = extra?.requestInfo?.headers ?? {};
        const token =
          (extra?._meta?.["x402.payment"] as string | undefined) ??
          headers["X-PAYMENT"];

        const paymentRequired = (
          reason = "PAYMENT_REQUIRED",
          extraFields: Record<string, unknown> = {}
        ) => {
          const payload = {
            x402Version,
            error: reason,
            accepts: [requirements],
            ...extraFields
          };
          return {
            isError: true,
            _meta: { "x402.error": payload },
            content: [{ type: "text", text: JSON.stringify(payload) }]
          } as const;
        };

        if (!token) return paymentRequired();

        // Decode & verify
        let decoded: PaymentPayload;
        try {
          decoded = exact.evm.decodePayment(z.string().parse(token));
          decoded.x402Version = x402Version;
        } catch {
          return paymentRequired("INVALID_PAYMENT");
        }

        const vr = await verify(decoded, requirements);
        if (!vr.isValid) {
          return paymentRequired(vr.invalidReason ?? "INVALID_PAYMENT", {
            payer: vr.payer
          });
        }

        // Execute tool
        let result: CallToolResult;
        let failed = false;
        try {
          result = await cb(args, extra);
          if (
            result &&
            typeof result === "object" &&
            "isError" in result &&
            result.isError
          ) {
            failed = true;
          }
        } catch (e) {
          failed = true;
          result = {
            isError: true,
            content: [
              { type: "text", text: `Tool execution failed: ${String(e)}` }
            ]
          };
        }

        // Settle only on success
        if (!failed) {
          try {
            const s = await settle(decoded, requirements);
            if (s.success) {
              result._meta ??= {};
              result._meta["x402.payment-response"] = {
                success: true,
                transaction: s.transaction,
                network: s.network,
                payer: s.payer
              };
            }
          } catch {
            return paymentRequired("SETTLEMENT_FAILED");
          }
        }

        return result;
      }) as ToolCallback<Args>
    );
  }

  Object.defineProperty(server, "paidTool", {
    value: paidTool,
    writable: false,
    enumerable: false,
    configurable: true
  });

  // Tell TS the object now also has the paidTool method
  return server as T & X402AugmentedServer;
}
