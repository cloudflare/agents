import type {
  CallToolResult,
  InputRequiredResult,
  ServerContext,
  StandardSchemaWithJSON,
  ToolCallback
} from "@modelcontextprotocol/server";
import type { PaymentPayload } from "@x402/core/types";
import { withX402 as withPayment, type X402Config } from "./index";

// MCP errors and intermediate input requests are results, not thrown errors.
// Carry them through the generic executor without settling a payment.
class UnsettledToolResult {
  constructor(readonly result: CallToolResult | InputRequiredResult) {}
}

/** Wrap an MCP SDK v2 tool callback; register it with server.registerTool(). */
export function withX402<Input extends StandardSchemaWithJSON | undefined>(
  handler: ToolCallback<Input>,
  config: X402Config
): ToolCallback<Input> {
  const invoke = handler as (
    ...args: Parameters<ToolCallback<Input>>
  ) =>
    | CallToolResult
    | InputRequiredResult
    | Promise<CallToolResult | InputRequiredResult>;
  const paid = withPayment(async (args: Parameters<ToolCallback<Input>>) => {
    const context = args[args.length - 1] as ServerContext;
    context.mcpReq.signal.throwIfAborted();
    const result = await invoke(...args);
    context.mcpReq.signal.throwIfAborted();
    if (result.resultType === "input_required" || result.isError) {
      throw new UnsettledToolResult(result);
    }
    return result as CallToolResult;
  }, config);

  return (async (...args: Parameters<ToolCallback<Input>>) => {
    const context = args[args.length - 1] as ServerContext;
    context.mcpReq.signal.throwIfAborted();
    const candidate = context.mcpReq._meta?.["x402/payment"];
    const payment =
      typeof candidate === "object" && candidate !== null
        ? (candidate as PaymentPayload)
        : undefined;
    try {
      const outcome = await paid(args, payment);
      if (outcome.status === "payment-required") {
        // Match upstream @x402/mcp's structured tool-result challenge.
        return {
          isError: true,
          structuredContent: { ...outcome.paymentRequired },
          content: [
            { type: "text", text: JSON.stringify(outcome.paymentRequired) }
          ]
        };
      }
      if (outcome.status === "settlement-failed") {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Payment settlement failed: ${outcome.settlement.errorReason ?? "unknown error"}`
            }
          ],
          _meta: { "x402/payment-response": outcome.settlement }
        };
      }
      return {
        ...outcome.result,
        _meta: {
          ...outcome.result._meta,
          "x402/payment-response": outcome.settlement
        }
      };
    } catch (error) {
      if (error instanceof UnsettledToolResult) return error.result;
      throw error;
    }
  }) as ToolCallback<Input>;
}
