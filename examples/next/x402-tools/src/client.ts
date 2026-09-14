import {
  Client,
  StreamableHTTPClientTransport
} from "@modelcontextprotocol/client";
import { x402Client } from "@x402/core/client";
import { isPaymentRequired } from "@x402/core/schemas";
import type { PaymentRequired } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const key = process.env.CLIENT_TEST_PK;
if (!key)
  throw new Error(
    "Set CLIENT_TEST_PK in .env to a Base Sepolia test wallet key"
  );
const baseUrl = process.env.SERVER_URL ?? "http://localhost:8787";
const transport = process.argv[2] ?? "http";
const payments = new x402Client();
registerExactEvmScheme(payments, {
  signer: toClientEvmSigner(privateKeyToAccount(key as `0x${string}`))
});

// Spending policy belongs to the application. Check the actual selection
// before signing, then ask for approval; approval cannot override the cap.
payments.onBeforePaymentCreation(async ({ selectedRequirements: selected }) => {
  if (
    selected.network !== "eip155:84532" ||
    selected.asset.toLowerCase() !==
      "0x036cbd53842c5426634e7929541ec2318f3dcf7e" ||
    !/^\d+$/.test(selected.amount) ||
    BigInt(selected.amount) > 100000n
  ) {
    throw new Error(
      "Only Base Sepolia USDC payments up to 0.10 USDC are allowed"
    );
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question(
      `Pay ${formatUnits(BigInt(selected.amount), 6)} USDC to ${selected.payTo}? [y/N] `
    );
    if (answer.trim().toLowerCase() !== "y")
      throw new Error("Payment declined");
  } finally {
    prompt.close();
  }
});

if (transport === "http") {
  const fetchPaid = wrapFetchWithPayment(fetch, payments);
  const response = await fetchPaid(new URL("/square", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ number: 5 })
  });
  console.log(response.status, await response.json());
} else if (transport === "mcp") {
  const client = new Client({ name: "Paid tools demo", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", baseUrl))
    );
    const params = { name: "square", arguments: { number: 5 } };
    let result = await client.callTool(params);
    if (
      result.isError &&
      isPaymentRequired(result.structuredContent) &&
      result.structuredContent.x402Version === 2
    ) {
      const payment = await payments.createPaymentPayload(
        result.structuredContent as PaymentRequired
      );
      result = await client.callTool({
        ...params,
        _meta: { "x402/payment": payment }
      });
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.close();
  }
} else {
  throw new Error("Choose http or mcp");
}
