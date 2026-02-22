/**
 * X402 MCP Integration (v2)
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
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";

// v2 imports from @x402/core
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import type { FacilitatorConfig, ResourceConfig } from "@x402/core/server";
import { x402Client } from "@x402/core/client";
import type {
  PaymentPayload,
  PaymentRequirements,
  PaymentRequired,
  Network
} from "@x402/core/types";

// v2 imports from @x402/evm
import { registerExactEvmScheme as registerServerEvmScheme } from "@x402/evm/exact/server";
import { registerExactEvmScheme as registerClientEvmScheme } from "@x402/evm/exact/client";
import type { ClientEvmSigner } from "@x402/evm";

// Re-export commonly used types for consumer convenience
export type {
  PaymentRequirements,
  PaymentRequired,
  Network
} from "@x402/core/types";
export type { FacilitatorConfig } from "@x402/core/server";
export type { ClientEvmSigner } from "@x402/evm";

/**
 * Map of legacy v1 network names to CAIP-2 identifiers.
 * Allows backward compatibility with v1 config.
 */
const LEGACY_NETWORK_MAP: Record<string, string> = {
  "base-sepolia": "eip155:84532",
  base: "eip155:8453",
  ethereum: "eip155:1",
  sepolia: "eip155:11155111"
};

/**
 * Normalize a network identifier to CAIP-2 format.
 * Accepts both legacy v1 names ("base-sepolia") and CAIP-2 ("eip155:84532").
 */
export function normalizeNetwork(network: string): Network {
  return (LEGACY_NETWORK_MAP[network] ?? network) as Network;
}

/*
  ======= SERVER SIDE =======
*/

export type X402Config = {
  /**
   * Network identifier.
   * Accepts both legacy names ("base-sepolia") and CAIP-2 format ("eip155:84532").
   */
  network: string;
  /** Payment recipient address */
  recipient: `0x${string}`;
  /** Facilitator configuration. Defaults to https://x402.org/facilitator */
  facilitator?: FacilitatorConfig;
  /** @deprecated No longer used in v2. The protocol version is determined automatically. */
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
  server: T,
  cfg: X402Config
): T & X402AugmentedServer {
  const network = normalizeNetwork(cfg.network);
  const facilitatorConfig: FacilitatorConfig = cfg.facilitator ?? {
    url: "https://x402.org/facilitator"
  };

  // Create v2 resource server with facilitator client
  const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);
  const resourceServer = new x402ResourceServer(facilitatorClient);
  registerServerEvmScheme(resourceServer);

  // Lazy initialization: fetch supported kinds from facilitator on first use
  let initPromise: Promise<void> | null = null;
  function ensureInitialized(): Promise<void> {
    if (!initPromise) {
      initPromise = resourceServer.initialize().catch((err) => {
        initPromise = null; // allow retry on failure
        throw err;
      });
    }
    return initPromise;
  }

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
        await ensureInitialized();

        // Build v2 payment requirements for this tool call
        const resourceConfig: ResourceConfig = {
          scheme: "exact",
          payTo: cfg.recipient,
          price: priceUSD,
          network,
          maxTimeoutSeconds: 300
        };

        let requirements: PaymentRequirements[];
        try {
          requirements =
            await resourceServer.buildPaymentRequirements(resourceConfig);
        } catch {
          const payload = { x402Version: 2, error: "PRICE_COMPUTE_FAILED" };
          return {
            isError: true,
            _meta: { "x402/error": payload },
            content: [{ type: "text", text: JSON.stringify(payload) }]
          } as const;
        }

        const resourceInfo = {
          url: `x402://${name}`,
          description,
          mimeType: "application/json"
        };

        // Get payment token from MCP _meta or HTTP headers
        // Support both v2 (PAYMENT-SIGNATURE) and v1 (X-PAYMENT) header names
        const headers = extra?.requestInfo?.headers ?? {};
        const token =
          (extra?._meta?.["x402/payment"] as string | undefined) ??
          headers["PAYMENT-SIGNATURE"] ??
          headers["X-PAYMENT"];

        const paymentRequired = (
          reason = "PAYMENT_REQUIRED",
          extraFields: Record<string, unknown> = {}
        ) => {
          const payload = {
            x402Version: 2,
            error: reason,
            resource: resourceInfo,
            accepts: requirements,
            ...extraFields
          };
          return {
            isError: true,
            _meta: { "x402/error": payload },
            content: [{ type: "text", text: JSON.stringify(payload) }]
          } as const;
        };

        if (!token || typeof token !== "string") return paymentRequired();

        // Decode the payment payload (base64-encoded JSON)
        let paymentPayload: PaymentPayload;
        try {
          paymentPayload = JSON.parse(atob(token));
        } catch {
          return paymentRequired("INVALID_PAYMENT");
        }

        // Find matching requirements for this payment
        const matchingReq = resourceServer.findMatchingRequirements(
          requirements,
          paymentPayload
        );
        if (!matchingReq) {
          return paymentRequired("INVALID_PAYMENT");
        }

        // Verify payment with facilitator
        try {
          const vr = await resourceServer.verifyPayment(
            paymentPayload,
            matchingReq
          );
          if (!vr.isValid) {
            return paymentRequired(vr.invalidReason ?? "INVALID_PAYMENT", {
              payer: vr.payer
            });
          }
        } catch {
          return paymentRequired("INVALID_PAYMENT");
        }

        // Execute the tool callback
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

        // Settle payment only on success
        if (!failed) {
          try {
            const s = await resourceServer.settlePayment(
              paymentPayload,
              matchingReq
            );
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
  /**
   * EVM account/signer for signing payment authorizations.
   * Use `privateKeyToAccount()` from viem/accounts to create one.
   */
  account: ClientEvmSigner;
  /**
   * Preferred network identifier (optional).
   * Accepts both legacy names ("base-sepolia") and CAIP-2 format ("eip155:84532").
   * When set, the client prefers payment requirements matching this network.
   * If omitted, the client automatically selects from available requirements.
   */
  network?: string;
  /** Maximum payment value in atomic units (default: 0.10 USDC = 100000) */
  maxPaymentValue?: bigint;
  /** @deprecated No longer used in v2. The protocol version is determined automatically. */
  version?: number;
  /** Confirmation callback for payment approval */
  confirmationCallback?: (payment: PaymentRequirements[]) => Promise<boolean>;
};

export function withX402Client<T extends MCPClient>(
  client: T,
  x402Config: X402ClientConfig
): X402AugmentedClient & T {
  const { account } = x402Config;

  const maxPaymentValue = x402Config.maxPaymentValue ?? BigInt(100_000); // 0.10 USDC

  // Create v2 x402 payment client with EVM scheme support
  const paymentClient = new x402Client();
  registerClientEvmScheme(paymentClient, { signer: account });

  // If a preferred network is specified, register a policy to prefer it
  if (x402Config.network) {
    const preferredNetwork = normalizeNetwork(x402Config.network);
    paymentClient.registerPolicy((_version, reqs) => {
      const matching = reqs.filter((r) => r.network === preferredNetwork);
      return matching.length > 0 ? matching : reqs;
    });
  }

  const _listTools = client.listTools.bind(client);

  // Wrap the original method to include payment information in the description
  const listTools: typeof _listTools = async (params, options) => {
    const toolsRes = await _listTools(params, options);
    return {
      ...toolsRes,
      tools: toolsRes.tools.map((tool) => {
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
      })
    };
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
    // Call the tool
    const res = await _callTool(params, resultSchema, options);

    // Check for x402 payment required error in response metadata
    const maybeX402Error = res._meta?.["x402/error"] as
      | (PaymentRequired & Record<string, unknown>)
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

      // Use the confirmation callback if provided
      if (confirmationCallback && !(await confirmationCallback(accepts))) {
        return {
          isError: true,
          content: [{ type: "text", text: "User declined payment" }]
        };
      }

      // Check max payment value against the first requirement's amount
      const selectedReq = accepts[0];
      if (!selectedReq || selectedReq.scheme !== "exact") return res;

      let amount: bigint;
      try {
        amount = BigInt(selectedReq.amount);
      } catch {
        return res; // malformed amount — return original error
      }
      if (amount > maxPaymentValue) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Payment exceeds client cap: ${amount} > ${maxPaymentValue}`
            }
          ]
        };
      }

      // Reconstruct the PaymentRequired response for the v2 x402 client
      const paymentRequiredResponse: PaymentRequired = {
        x402Version: (maybeX402Error.x402Version as number) ?? 2,
        resource: (maybeX402Error.resource as PaymentRequired["resource"]) ?? {
          url: "",
          description: "",
          mimeType: "application/json"
        },
        accepts,
        extensions: maybeX402Error.extensions as
          | Record<string, unknown>
          | undefined
      };

      // Create the payment payload using the v2 x402 client
      let paymentPayload: PaymentPayload;
      try {
        paymentPayload = await paymentClient.createPaymentPayload(
          paymentRequiredResponse
        );
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: "Failed to create payment payload" }]
        };
      }

      // Encode the payment payload as a base64 JSON token for MCP transport
      const token = btoa(JSON.stringify(paymentPayload));

      // Retry the tool call with the payment token
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
  Object.defineProperty(_client, "listTools", {
    value: listTools,
    writable: false,
    enumerable: false,
    configurable: true
  });
  Object.defineProperty(_client, "callTool", {
    value: callToolWithPayment,
    writable: false,
    enumerable: false,
    configurable: true
  });

  return _client;
}
