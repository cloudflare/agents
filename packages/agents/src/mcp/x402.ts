/**
 * X402 MCP Integration
 *
 * Based on:
 * - Coinbase's x402 (Apache 2.0): https://github.com/coinbase/x402
 * - @ethanniser and his work at https://github.com/ethanniser/x402-mcp
 */

import type {
  McpServer,
  RegisteredTool,
  ToolCallback
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  CallToolResultSchema,
  CompatibilityCallToolResultSchema,
  CallToolRequest,
  CallToolResult,
  ToolAnnotations
} from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";
import { base, baseSepolia, type Chain } from "viem/chains";

import { processPriceToAtomicAmount } from "x402/shared";
import { exact } from "x402/schemes";
import { useFacilitator } from "x402/verify";
import type {
  FacilitatorConfig,
  Network,
  PaymentPayload,
  PaymentRequirements,
  Wallet
} from "x402/types";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { createWalletClient, http, type Account } from "viem";
import { createPaymentHeader } from "x402/client";

/*
  ======= SERVER SIDE =======
*/

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
    return server.registerTool(
      name,
      {
        description,
        inputSchema: paramsSchema,
        annotations,
        _meta: {
          "agents-x402/paymentRequired": true,
          "agents-x402/priceUSD": priceUSD
        }
      },
      (async (args, extra) => {
        // Build PaymentRequirements for this call
        const atomic = processPriceToAtomicAmount(priceUSD, cfg.network);
        if ("error" in atomic) {
          const payload = { x402Version, error: "PRICE_COMPUTE_FAILED" };
          return {
            isError: true,
            _meta: { "x402/error": payload },
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
          resource: `x402://${name}`,
          mimeType: "application/json" as const,
          description,
          extra: "eip712" in asset ? asset.eip712 : undefined
        };

        // Get token either from MCP _meta or from header
        const headers = extra?.requestInfo?.headers ?? {};
        const token =
          (extra?._meta?.["x402/payment"] as string | undefined) ??
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
            _meta: { "x402/error": payload },
            content: [{ type: "text", text: JSON.stringify(payload) }]
          } as const;
        };

        if (!token || typeof token !== "string") return paymentRequired();

        // Decode & verify
        let decoded: PaymentPayload;
        try {
          decoded = exact.evm.decodePayment(token);
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
              result._meta["x402/payment-response"] = {
                success: true,
                transaction: s.transaction,
                network: s.network,
                payer: s.payer
              };
            } else {
              return paymentRequired(s.errorReason ?? "SETTLEMENT_FAILED");
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

/*
  ======= CLIENT SIDE =======
*/

const toChain = (network: Network): Chain => {
  switch (network) {
    case "base":
      return base;
    case "base-sepolia":
      return baseSepolia;
    default:
      throw new Error(`Unsupported network: ${network}`);
  }
};

export interface X402AugmentedClient {
  callTool(
    x402ConfirmationCallback:
      | ((payment: PaymentRequirements[]) => Promise<boolean>)
      | null,
    params: CallToolRequest["params"],
    resultSchema?:
      | typeof CallToolResultSchema
      | typeof CompatibilityCallToolResultSchema,
    options?: RequestOptions
  ): Promise<CallToolResult>;
}

export type X402ClientConfig = {
  network: Network; // we only support base and base-sepolia for now
  account: Account;
  maxPaymentValue?: bigint;
  version?: number;
  confirmationCallback?: (payment: PaymentRequirements[]) => Promise<boolean>; // Confirmation callback for payment
};

export function withX402Client<T extends MCPClient>(
  client: T,
  x402Config: X402ClientConfig
): X402AugmentedClient & T {
  const { network, account, version } = x402Config;
  const wallet = createWalletClient({
    account,
    transport: http(),
    chain: toChain(network)
  });

  const maxPaymentValue = x402Config.maxPaymentValue ?? BigInt(0.1 * 10 ** 6); // 0.10 USDC

  const _listTools = client.listTools.bind(client);

  // Wrap the original method to include payment information in the description
  const listTools: typeof _listTools = async (params, options) => {
    const toolsRes = await _listTools(params, options);
    toolsRes.tools = toolsRes.tools.map((tool) => {
      let description = tool.description;
      // Check _meta for payment information (agents-x402/ is our extension for pre-advertising prices)
      if (tool._meta?.["agents-x402/paymentRequired"]) {
        const cost = tool._meta?.["agents-x402/priceUSD"]
          ? `$${tool._meta?.["agents-x402/priceUSD"]}`
          : "an unknown amount";
        description += ` (This is a paid tool, you will be charged ${cost} for its execution)`;
      }
      return {
        ...tool,
        description
      };
    });

    // Wrap each tool to add payment support

    return toolsRes;
  };

  const _callTool = client.callTool.bind(client);

  const callToolWithPayment = async (
    x402ConfirmationCallback:
      | ((payment: PaymentRequirements[]) => Promise<boolean>)
      | null,
    params: CallToolRequest["params"],
    resultSchema?:
      | typeof CallToolResultSchema
      | typeof CompatibilityCallToolResultSchema,
    options?: RequestOptions
  ): ReturnType<typeof client.callTool> => {
    // call the tool
    const res = await _callTool(params, resultSchema, options);
    console.log("res", res);

    // If it errored and returned accepts, we need to confirm payment
    const maybeX402Error = res._meta?.["x402/error"] as
      | { accepts: PaymentRequirements[] }
      | undefined;

    if (
      res.isError &&
      maybeX402Error &&
      maybeX402Error.accepts &&
      Array.isArray(maybeX402Error.accepts) &&
      maybeX402Error.accepts.length > 0
    ) {
      const accepts = maybeX402Error.accepts;
      const confirmationCallback =
        x402ConfirmationCallback ?? x402Config.confirmationCallback;

      // Use the x402 confirmation callback if provided
      if (confirmationCallback && !(await confirmationCallback(accepts))) {
        return {
          isError: true,
          content: [{ type: "text", text: "User declined payment" }]
        };
      }

      // Pick the first exact-scheme requirement that matches our network
      // (we're only setting one on the McpAgent side for now)
      const req =
        accepts.find((a) => a?.scheme === "exact" && a?.network === network) ??
        accepts[0];

      if (!req || req.scheme !== "exact") return res;

      const maxAmountRequired = BigInt(req.maxAmountRequired);
      if (maxAmountRequired > maxPaymentValue) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Payment exceeds client cap: ${maxAmountRequired} > ${maxPaymentValue}`
            }
          ]
        };
      }

      // Use x402/client to get the X-PAYMENT token
      const token = await createPaymentHeader(
        wallet as Wallet,
        version ?? 1,
        req
      );

      // Call the tool with the payment token
      return _callTool(
        {
          ...params,
          _meta: {
            ...params._meta,
            "x402/payment": token
          }
        },
        resultSchema,
        options
      );
    }

    return res;
  };

  const _client = client as X402AugmentedClient & T;
  _client.listTools = listTools;
  Object.defineProperty(_client, "callTool", {
    value: callToolWithPayment,
    writable: false,
    enumerable: false,
    configurable: true
  });

  return _client;
}
