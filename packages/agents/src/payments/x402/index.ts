import type { x402ResourceServer } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  ResourceInfo,
  SettleResponse
} from "@x402/core/types";

export type X402Config = {
  /** An initialized upstream resource server with the desired schemes registered. */
  server: x402ResourceServer;
  /** Build these with server.buildPaymentRequirements(). */
  accepts: PaymentRequirements[];
  resource: ResourceInfo;
};

export type X402Result<T> =
  | { status: "payment-required"; paymentRequired: PaymentRequired }
  | { status: "success"; result: T; settlement: SettleResponse }
  | { status: "settlement-failed"; settlement: SettleResponse };

/**
 * Require x402 payment for a function, independent of its transport or schema.
 * Verification precedes execution; settlement follows successful execution.
 * A thrown handler error is propagated without settling. Settlement failure
 * does not expose the result or request another payment: execution already ran.
 * Use idempotent handlers; execution and on-chain settlement are not atomic.
 */
export function withX402<Input, Output>(
  handler: (input: Input) => Output | Promise<Output>,
  config: X402Config
): (input: Input, payment?: PaymentPayload) => Promise<X402Result<Output>> {
  if (config.accepts.length === 0) {
    throw new TypeError("At least one payment requirement is required");
  }
  const { server } = config;
  const accepts = structuredClone(config.accepts);
  const resource = structuredClone(config.resource);

  return async (input, payment) => {
    const paymentRequired = await server.createPaymentRequiredResponse(
      structuredClone(accepts),
      structuredClone(resource)
    );
    const challenge = (error?: string): X402Result<Output> => ({
      status: "payment-required",
      paymentRequired: { ...paymentRequired, ...(error ? { error } : {}) }
    });
    if (!payment) return challenge();

    // Neither the caller nor the advertised challenge retains a mutable
    // reference to the payload/requirements used for verification and settlement.
    const payload = structuredClone(payment);
    let requirement: PaymentRequirements | undefined;
    try {
      requirement = server.findMatchingRequirements(
        paymentRequired.accepts,
        payload
      );
    } catch {
      return challenge("INVALID_PAYMENT");
    }
    if (!requirement) return challenge("INVALID_PAYMENT");

    const verification = await server.verifyPayment(payload, requirement);
    if (!verification.isValid) {
      return challenge(verification.invalidReason ?? "INVALID_PAYMENT");
    }

    const result = await handler(input);
    const settlement = await server.settlePayment(payload, requirement);
    if (!settlement.success) return { status: "settlement-failed", settlement };
    return { status: "success", result, settlement };
  };
}
