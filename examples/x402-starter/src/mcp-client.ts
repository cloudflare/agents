/**
 * X402 MCP Client Integration
 * Wraps MCP client with X402 payment capabilities
 */

import { X402Client } from "./payment-client";
import { CoinbaseWallet } from "./coinbase-wallet";

export interface X402MCPOptions {
  wallet?: CoinbaseWallet;
  walletAddress?: string;
  autoPayment?: boolean;
  maxPaymentAmount?: number;
}

/**
 * Wrap an MCP client with X402 payment support
 */
export function withX402Payment(
  mcpClient: any,
  options: X402MCPOptions = {}
): any {
  const x402Client = new X402Client(options);

  // Store original methods
  const originalCallTool = mcpClient.callTool?.bind(mcpClient);
  const originalListTools = mcpClient.tools?.bind(mcpClient);

  // Override callTool to handle payments
  if (originalCallTool) {
    mcpClient.callTool = async (toolName: string, args: any) => {
      try {
        // First try without payment
        return await originalCallTool(toolName, args);
      } catch (error: any) {
        // Check if payment is required
        if (error.message?.includes("Payment required")) {
          const paymentInfo = extractPaymentInfo(error.message);

          if (paymentInfo && options.autoPayment) {
            // Check payment amount limit
            if (paymentInfo.amount > (options.maxPaymentAmount || 0.1)) {
              throw new Error(
                `Payment amount ${paymentInfo.amount} exceeds maximum ${options.maxPaymentAmount || 0.1}`
              );
            }

            // Create payment authorization
            const paymentAuth = await createPaymentAuthorization(
              paymentInfo,
              options
            );

            // Retry with payment
            const argsWithPayment = {
              ...args,
              paymentAuthorization: paymentAuth
            };

            return await originalCallTool(toolName, argsWithPayment);
          }
        }
        throw error;
      }
    };
  }

  // Override tools list to show payment information
  if (originalListTools) {
    mcpClient.tools = async () => {
      const tools = await originalListTools();

      // The AI SDK expects a ToolSet object: { [name]: Tool }
      // Some clients might return an object, others an array; handle both safely.
      if (tools && typeof tools === "object" && !Array.isArray(tools)) {
        // Mutate descriptions in-place and return the object
        for (const key of Object.keys(tools)) {
          const t = (tools as any)[key];
          try {
            if (t && (t as any).paymentRequired) {
              (t as any).description =
                `${(t as any).description} [💰 ${(t as any).price} ${(t as any).currency}]`;
            }
          } catch {
            // ignore description enhancement errors
          }
        }
        return tools;
      }

      if (Array.isArray(tools)) {
        // Convert array -> object by tool name
        const mapped: Record<string, any> = {};
        for (const t of tools as any[]) {
          if (!t || !t.name) continue;
          try {
            if ((t as any).paymentRequired) {
              (t as any).description =
                `${t.description} [💰 ${t.price} ${t.currency}]`;
            }
          } catch {
            // ignore
          }
          mapped[(t as any).name] = t;
        }
        return mapped;
      }

      // Fallback: return as-is
      return tools;
    };
  }

  // Add payment status method
  mcpClient.getPaymentStatus = () => {
    return {
      autoPayment: options.autoPayment,
      maxPaymentAmount: options.maxPaymentAmount,
      walletAddress: options.walletAddress
    };
  };

  return mcpClient;
}

/**
 * Extract payment information from error message
 */
function extractPaymentInfo(errorMessage: string): any {
  try {
    const match = errorMessage.match(/Payment required: (.+)/);
    if (match) {
      return JSON.parse(match[1]);
    }
  } catch (error) {
    console.error("Failed to parse payment info:", error);
  }
  return null;
}

/**
 * Create payment authorization for MCP tool
 */
async function createPaymentAuthorization(
  paymentInfo: any,
  options: X402MCPOptions
) {
  const paymentId = `mcp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // In production, use real wallet to create payment
  if (options.wallet) {
    // Ensure sufficient funds
    const hasFunds = await options.wallet.hasSufficientFunds(
      paymentInfo.amount,
      paymentInfo.currency
    );

    if (!hasFunds) {
      // Try to request funds from faucet (testnet only)
      await options.wallet.requestFunds(
        paymentInfo.currency,
        paymentInfo.amount * 2
      );
    }

    // Create actual payment
    const actualPaymentId = await options.wallet.createPayment(
      paymentInfo.amount,
      paymentInfo.currency,
      paymentInfo.recipient,
      paymentInfo.description
    );

    return {
      paymentId: actualPaymentId,
      amount: paymentInfo.amount,
      currency: paymentInfo.currency,
      recipient: paymentInfo.recipient,
      timestamp: Date.now(),
      signature: `signature_${actualPaymentId}`
    };
  }

  // Demo mode without wallet
  return {
    paymentId,
    amount: paymentInfo.amount,
    currency: paymentInfo.currency,
    recipient: paymentInfo.recipient,
    timestamp: Date.now(),
    signature: `demo_signature_${paymentId}`
  };
}

/**
 * Create an X402-enabled MCP client factory
 */
export function createX402MCPClient(options: X402MCPOptions = {}) {
  return {
    wrap: (mcpClient: any) => withX402Payment(mcpClient, options),
    options
  };
}
