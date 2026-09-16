import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme as registerServer } from "@x402/evm/exact/server";
import { registerExactEvmScheme as registerClient } from "@x402/evm/exact/client";
import type { PaymentRequired } from "@x402/core/types";
import { vi } from "vitest";

export async function paymentFixture() {
  const verify = vi
    .fn<FacilitatorClient["verify"]>()
    .mockResolvedValue({ isValid: true });
  const settle = vi.fn<FacilitatorClient["settle"]>().mockResolvedValue({
    success: true,
    transaction: "0xtransaction",
    network: "eip155:84532"
  });
  const server = new x402ResourceServer({
    verify,
    settle,
    getSupported: async () => ({
      kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }],
      extensions: [],
      signers: {}
    })
  });
  registerServer(server);
  await server.initialize();
  const accepts = await server.buildPaymentRequirements({
    scheme: "exact",
    network: "eip155:84532",
    payTo: "0x1111111111111111111111111111111111111111",
    price: "$0.01"
  });
  const config = {
    server,
    accepts,
    resource: {
      url: "https://tools.test/square",
      description: "Square a number"
    }
  };
  const payer = new x402Client();
  registerClient(payer, {
    signer: {
      address: "0x2222222222222222222222222222222222222222",
      signTypedData: async () => `0x${"11".repeat(65)}`
    }
  });
  const sign = (required: PaymentRequired) =>
    payer.createPaymentPayload(required);
  const required = await server.createPaymentRequiredResponse(
    accepts,
    config.resource
  );
  const payment = await sign(required);
  return { config, payment, verify, settle, sign };
}
