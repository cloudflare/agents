import { Client } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import {
  withX402Client,
  type ClientEvmSigner,
  type PaymentRequirements
} from "../mcp/client/x402";

const requirement: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "10000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x1111111111111111111111111111111111111111",
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" }
};

// Use the real x402 selector and EVM scheme. Only MCP I/O and signing are stubbed.
function setup(
  accepts: PaymentRequirements[],
  network?: string,
  cap = 100000n
) {
  const client = new Client({ name: "payment-test", version: "1.0.0" });
  const callTool = vi
    .spyOn(client, "callTool")
    .mockResolvedValueOnce({
      isError: true,
      content: [],
      _meta: {
        "x402/error": {
          x402Version: 2,
          resource: { url: "x402://test", description: "Test" },
          accepts
        }
      }
    })
    .mockResolvedValue({ content: [{ type: "text", text: "Paid" }] });
  const signTypedData = vi
    .fn<ClientEvmSigner["signTypedData"]>()
    .mockResolvedValue(`0x${"11".repeat(65)}`);
  return {
    client: withX402Client(client, {
      account: {
        address: "0x2222222222222222222222222222222222222222",
        signTypedData
      },
      network,
      maxPaymentValue: cap
    }),
    callTool,
    signTypedData
  };
}

describe("x402 selected-payment cap", () => {
  it.each([
    { firstNetwork: "eip155:1", preferredNetwork: "base-sepolia" },
    { firstNetwork: "solana:unsupported", preferredNetwork: undefined }
  ] as const)(
    "rejects an expensive selection after $firstNetwork",
    async ({ firstNetwork, preferredNetwork }) => {
      const { client, callTool, signTypedData } = setup(
        [
          { ...requirement, network: firstNetwork, amount: "1" },
          { ...requirement, amount: "999999999" }
        ],
        preferredNetwork
      );
      const result = await client.callTool(null, { name: "test" });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "Payment exceeds client cap: 999999999 > 100000" }
      ]);
      expect(signTypedData).not.toHaveBeenCalled();
      expect(callTool).toHaveBeenCalledOnce();
    }
  );

  it("still rejects a single over-cap requirement", async () => {
    const { client, callTool, signTypedData } = setup([
      { ...requirement, amount: "100001" }
    ]);
    expect((await client.callTool(null, { name: "test" })).isError).toBe(true);
    expect(signTypedData).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledOnce();
  });

  it.each(["1", "999999999"])(
    "pays an affordable selection when the unselected offer costs %s",
    async (amount) => {
      const { client, callTool, signTypedData } = setup(
        [{ ...requirement, network: "eip155:1", amount }, requirement],
        "base-sepolia"
      );
      expect(
        (await client.callTool(null, { name: "test" })).isError
      ).toBeUndefined();
      expect(signTypedData).toHaveBeenCalledOnce();
      expect(callTool).toHaveBeenCalledTimes(2);
      const token = callTool.mock.calls[1][0]._meta?.["x402/payment"] as string;
      expect(JSON.parse(atob(token)).accepted).toEqual(requirement);
    }
  );

  it("ignores requirement mutations made through the confirmation callback", async () => {
    const { client, callTool, signTypedData } = setup([{ ...requirement }]);
    const result = await client.callTool(
      async (accepts) => {
        queueMicrotask(() =>
          queueMicrotask(() => {
            accepts[0].amount = "999999999";
          })
        );
        return true;
      },
      { name: "test" }
    );
    expect(result.isError).toBeUndefined();
    expect(signTypedData).toHaveBeenCalledOnce();
    const token = callTool.mock.calls[1][0]._meta?.["x402/payment"] as string;
    expect(JSON.parse(atob(token)).accepted.amount).toBe("10000");
  });

  it("allows exactly the cap without number rounding", async () => {
    const cap = 9007199254740993n;
    const { client, signTypedData } = setup(
      [{ ...requirement, amount: String(cap) }],
      undefined,
      cap
    );
    expect(
      (await client.callTool(null, { name: "test" })).isError
    ).toBeUndefined();
    expect(signTypedData).toHaveBeenCalledOnce();
  });

  it.each(["-1", "1.5", "nope"])(
    "returns the original 402 result for malformed selected amount %s",
    async (amount) => {
      const { client, callTool, signTypedData } = setup([
        { ...requirement, amount }
      ]);
      const result = await client.callTool(null, { name: "test" });
      expect(result.isError).toBe(true);
      expect(result._meta?.["x402/error"]).toBeDefined();
      expect(signTypedData).not.toHaveBeenCalled();
      expect(callTool).toHaveBeenCalledOnce();
    }
  );
});
