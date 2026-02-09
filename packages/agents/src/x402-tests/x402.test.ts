import { describe, expect, it, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";

// --- Mock setup for @x402 modules ---

const mockResourceServer = {
  initialize: vi.fn().mockResolvedValue(undefined),
  buildPaymentRequirements: vi.fn(),
  findMatchingRequirements: vi.fn(),
  verifyPayment: vi.fn(),
  settlePayment: vi.fn()
};

const mockPaymentClient = {
  registerPolicy: vi.fn(),
  createPaymentPayload: vi.fn()
};

vi.mock("@x402/core/server", () => ({
  x402ResourceServer: vi.fn(() => mockResourceServer),
  HTTPFacilitatorClient: vi.fn()
}));

vi.mock("@x402/core/client", () => ({
  x402Client: vi.fn(() => mockPaymentClient)
}));

vi.mock("@x402/evm/exact/server", () => ({
  registerExactEvmScheme: vi.fn()
}));

vi.mock("@x402/evm/exact/client", () => ({
  registerExactEvmScheme: vi.fn()
}));

import {
  normalizeNetwork,
  withX402,
  withX402Client,
  type X402Config,
  type X402ClientConfig
} from "../mcp/x402";

// Helper: create a minimal McpServer mock
// We avoid naming anything `_registeredTools` since McpServer has a private field
// with that name, which would collapse the intersection type to `never`.
function createMockMcpServer() {
  const registerToolMock = vi.fn(
    (
      _name: string,
      _config: Record<string, unknown>,
      _callback: (...args: unknown[]) => unknown
    ) => {
      return { name: _name };
    }
  );

  const server = { registerTool: registerToolMock };
  return server as unknown as McpServer & {
    registerTool: typeof registerToolMock;
  };
}

/** Get the tool callback from the Nth registerTool call (0-indexed) */
function getRegisteredCallback(
  server: McpServer & { registerTool: ReturnType<typeof vi.fn> },
  index = 0
): (...args: unknown[]) => unknown {
  return server.registerTool.mock.calls[index][2];
}

// Helper: create a minimal MCPClient mock
function createMockMcpClient() {
  const client = {
    listTools: vi.fn(),
    callTool: vi.fn()
  };
  return client as unknown as MCPClient & {
    listTools: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
  };
}

const samplePaymentRequirements = [
  {
    scheme: "exact",
    network: "eip155:84532",
    amount: "10000",
    asset: "0xSomeToken",
    payTo: "0xRecipient",
    maxTimeoutSeconds: 300
  }
];

const defaultServerConfig: X402Config = {
  network: "base-sepolia",
  recipient: "0xRecipient"
};

const mockSigner = {
  address: "0xClientAddress",
  signTypedData: vi.fn()
};

// =============================================================
// normalizeNetwork
// =============================================================
describe("normalizeNetwork", () => {
  it("converts legacy 'base-sepolia' to CAIP-2", () => {
    expect(normalizeNetwork("base-sepolia")).toBe("eip155:84532");
  });

  it("converts legacy 'base' to CAIP-2", () => {
    expect(normalizeNetwork("base")).toBe("eip155:8453");
  });

  it("converts legacy 'ethereum' to CAIP-2", () => {
    expect(normalizeNetwork("ethereum")).toBe("eip155:1");
  });

  it("converts legacy 'sepolia' to CAIP-2", () => {
    expect(normalizeNetwork("sepolia")).toBe("eip155:11155111");
  });

  it("passes through CAIP-2 identifiers unchanged", () => {
    expect(normalizeNetwork("eip155:84532")).toBe("eip155:84532");
    expect(normalizeNetwork("eip155:1")).toBe("eip155:1");
  });

  it("passes through unknown strings unchanged", () => {
    expect(normalizeNetwork("polygon-mainnet")).toBe("polygon-mainnet");
    expect(normalizeNetwork("eip155:999")).toBe("eip155:999");
  });
});

// =============================================================
// withX402 (Server side)
// =============================================================
describe("withX402", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResourceServer.initialize.mockResolvedValue(undefined);
  });

  it("adds paidTool method to the server", () => {
    const server = createMockMcpServer();
    const augmented = withX402(server, defaultServerConfig);

    expect(augmented.paidTool).toBeDefined();
    expect(typeof augmented.paidTool).toBe("function");
  });

  it("registers a tool with correct metadata via paidTool", () => {
    const server = createMockMcpServer();
    const augmented = withX402(server, defaultServerConfig);

    augmented.paidTool(
      "test-tool",
      "A test tool",
      0.01,
      {},
      { title: "Test" },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] })
    );

    expect(server.registerTool).toHaveBeenCalledOnce();
    const callArgs = server.registerTool.mock.calls[0];
    expect(callArgs[0]).toBe("test-tool");
    expect(callArgs[1]).toMatchObject({
      description: "A test tool",
      annotations: { title: "Test" },
      _meta: {
        "agents-x402/paymentRequired": true,
        "agents-x402/priceUSD": 0.01
      }
    });
  });

  it("returns payment required when no token is provided", async () => {
    const server = createMockMcpServer();
    const augmented = withX402(server, defaultServerConfig);

    mockResourceServer.buildPaymentRequirements.mockResolvedValue(
      samplePaymentRequirements
    );

    augmented.paidTool("paid-tool", "Costs money", 0.01, {}, {}, async () => ({
      content: [{ type: "text" as const, text: "result" }]
    }));

    // Get the registered callback
    const registeredCb = getRegisteredCallback(server);

    // Call without token
    const result = (await registeredCb({}, {})) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, Record<string, unknown>>;
    expect(meta["x402/error"]).toBeDefined();
    expect(meta["x402/error"].error).toBe("PAYMENT_REQUIRED");
    expect(meta["x402/error"].accepts).toEqual(samplePaymentRequirements);
  });

  it("returns INVALID_PAYMENT for a non-base64 token", async () => {
    const server = createMockMcpServer();
    const augmented = withX402(server, defaultServerConfig);

    mockResourceServer.buildPaymentRequirements.mockResolvedValue(
      samplePaymentRequirements
    );

    augmented.paidTool("paid-tool", "Costs money", 0.01, {}, {}, async () => ({
      content: [{ type: "text" as const, text: "result" }]
    }));

    const registeredCb = getRegisteredCallback(server);

    // Call with invalid token via _meta
    const result = (await registeredCb(
      {},
      { _meta: { "x402/payment": "not-valid-json-base64!@#$" } }
    )) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, Record<string, unknown>>;
    expect(meta["x402/error"].error).toBe("INVALID_PAYMENT");
  });

  it("returns INVALID_PAYMENT when no matching requirements found", async () => {
    const server = createMockMcpServer();
    const augmented = withX402(server, defaultServerConfig);

    mockResourceServer.buildPaymentRequirements.mockResolvedValue(
      samplePaymentRequirements
    );
    mockResourceServer.findMatchingRequirements.mockReturnValue(null);

    augmented.paidTool("paid-tool", "Costs money", 0.01, {}, {}, async () => ({
      content: [{ type: "text" as const, text: "result" }]
    }));

    const registeredCb = getRegisteredCallback(server);

    // Valid base64 JSON token
    const fakePayload = { scheme: "exact", network: "eip155:84532" };
    const token = btoa(JSON.stringify(fakePayload));

    const result = (await registeredCb(
      {},
      { _meta: { "x402/payment": token } }
    )) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, Record<string, unknown>>;
    expect(meta["x402/error"].error).toBe("INVALID_PAYMENT");
  });

  it("returns INVALID_PAYMENT when verification fails", async () => {
    const server = createMockMcpServer();
    const augmented = withX402(server, defaultServerConfig);

    mockResourceServer.buildPaymentRequirements.mockResolvedValue(
      samplePaymentRequirements
    );
    mockResourceServer.findMatchingRequirements.mockReturnValue(
      samplePaymentRequirements[0]
    );
    mockResourceServer.verifyPayment.mockResolvedValue({
      isValid: false,
      invalidReason: "SIGNATURE_MISMATCH"
    });

    augmented.paidTool("paid-tool", "Costs money", 0.01, {}, {}, async () => ({
      content: [{ type: "text" as const, text: "result" }]
    }));

    const registeredCb = getRegisteredCallback(server);
    const fakePayload = { scheme: "exact", network: "eip155:84532" };
    const token = btoa(JSON.stringify(fakePayload));

    const result = (await registeredCb(
      {},
      { _meta: { "x402/payment": token } }
    )) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, Record<string, unknown>>;
    expect(meta["x402/error"].error).toBe("SIGNATURE_MISMATCH");
  });

  it("returns INVALID_PAYMENT when verifyPayment throws", async () => {
    const server = createMockMcpServer();
    const augmented = withX402(server, defaultServerConfig);

    mockResourceServer.buildPaymentRequirements.mockResolvedValue(
      samplePaymentRequirements
    );
    mockResourceServer.findMatchingRequirements.mockReturnValue(
      samplePaymentRequirements[0]
    );
    mockResourceServer.verifyPayment.mockRejectedValue(
      new Error("facilitator unreachable")
    );

    augmented.paidTool("paid-tool", "Costs money", 0.01, {}, {}, async () => ({
      content: [{ type: "text" as const, text: "result" }]
    }));

    const registeredCb = getRegisteredCallback(server);
    const fakePayload = { scheme: "exact", network: "eip155:84532" };
    const token = btoa(JSON.stringify(fakePayload));

    const result = (await registeredCb(
      {},
      { _meta: { "x402/payment": token } }
    )) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, Record<string, unknown>>;
    expect(meta["x402/error"].error).toBe("INVALID_PAYMENT");
  });

  it("executes tool callback and settles payment on valid payment", async () => {
    const server = createMockMcpServer();
    const augmented = withX402(server, defaultServerConfig);

    mockResourceServer.buildPaymentRequirements.mockResolvedValue(
      samplePaymentRequirements
    );
    mockResourceServer.findMatchingRequirements.mockReturnValue(
      samplePaymentRequirements[0]
    );
    mockResourceServer.verifyPayment.mockResolvedValue({ isValid: true });
    mockResourceServer.settlePayment.mockResolvedValue({
      success: true,
      transaction: "0xTxHash",
      network: "eip155:84532",
      payer: "0xPayer"
    });

    const toolCb = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Tool result!" }]
    });

    augmented.paidTool("paid-tool", "Costs money", 0.01, {}, {}, toolCb);

    const registeredCb = getRegisteredCallback(server);
    const fakePayload = { scheme: "exact", network: "eip155:84532" };
    const token = btoa(JSON.stringify(fakePayload));

    const result = (await registeredCb(
      {},
      { _meta: { "x402/payment": token } }
    )) as Record<string, unknown>;

    expect(toolCb).toHaveBeenCalledOnce();
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: "Tool result!" }]);

    // Check settlement metadata
    const meta = result._meta as Record<string, Record<string, unknown>>;
    expect(meta["x402/payment-response"]).toEqual({
      success: true,
      transaction: "0xTxHash",
      network: "eip155:84532",
      payer: "0xPayer"
    });
  });

  it("returns SETTLEMENT_FAILED when settlement fails", async () => {
    const server = createMockMcpServer();
    const augmented = withX402(server, defaultServerConfig);

    mockResourceServer.buildPaymentRequirements.mockResolvedValue(
      samplePaymentRequirements
    );
    mockResourceServer.findMatchingRequirements.mockReturnValue(
      samplePaymentRequirements[0]
    );
    mockResourceServer.verifyPayment.mockResolvedValue({ isValid: true });
    mockResourceServer.settlePayment.mockResolvedValue({
      success: false,
      errorReason: "INSUFFICIENT_FUNDS"
    });

    augmented.paidTool("paid-tool", "Costs money", 0.01, {}, {}, async () => ({
      content: [{ type: "text", text: "result" }]
    }));

    const registeredCb = getRegisteredCallback(server);
    const fakePayload = { scheme: "exact", network: "eip155:84532" };
    const token = btoa(JSON.stringify(fakePayload));

    const result = (await registeredCb(
      {},
      { _meta: { "x402/payment": token } }
    )) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, Record<string, unknown>>;
    expect(meta["x402/error"].error).toBe("INSUFFICIENT_FUNDS");
  });

  it("returns SETTLEMENT_FAILED when settlePayment throws", async () => {
    const server = createMockMcpServer();
    const augmented = withX402(server, defaultServerConfig);

    mockResourceServer.buildPaymentRequirements.mockResolvedValue(
      samplePaymentRequirements
    );
    mockResourceServer.findMatchingRequirements.mockReturnValue(
      samplePaymentRequirements[0]
    );
    mockResourceServer.verifyPayment.mockResolvedValue({ isValid: true });
    mockResourceServer.settlePayment.mockRejectedValue(
      new Error("facilitator timeout")
    );

    augmented.paidTool("paid-tool", "Costs money", 0.01, {}, {}, async () => ({
      content: [{ type: "text", text: "result" }]
    }));

    const registeredCb = getRegisteredCallback(server);
    const fakePayload = { scheme: "exact", network: "eip155:84532" };
    const token = btoa(JSON.stringify(fakePayload));

    const result = (await registeredCb(
      {},
      { _meta: { "x402/payment": token } }
    )) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, Record<string, unknown>>;
    expect(meta["x402/error"].error).toBe("SETTLEMENT_FAILED");
  });

  it("does not settle payment when tool callback returns isError", async () => {
    const server = createMockMcpServer();
    const augmented = withX402(server, defaultServerConfig);

    mockResourceServer.buildPaymentRequirements.mockResolvedValue(
      samplePaymentRequirements
    );
    mockResourceServer.findMatchingRequirements.mockReturnValue(
      samplePaymentRequirements[0]
    );
    mockResourceServer.verifyPayment.mockResolvedValue({ isValid: true });

    augmented.paidTool("paid-tool", "Costs money", 0.01, {}, {}, async () => ({
      isError: true as const,
      content: [{ type: "text" as const, text: "tool returned error" }]
    }));

    const registeredCb = getRegisteredCallback(server);
    const fakePayload = { scheme: "exact", network: "eip155:84532" };
    const token = btoa(JSON.stringify(fakePayload));

    const result = (await registeredCb(
      {},
      { _meta: { "x402/payment": token } }
    )) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ text: string }>;
    expect(content[0].text).toBe("tool returned error");

    // Settlement should NOT have been called because the tool reported an error
    expect(mockResourceServer.settlePayment).not.toHaveBeenCalled();
  });

  it("does not settle payment when tool callback fails", async () => {
    const server = createMockMcpServer();
    const augmented = withX402(server, defaultServerConfig);

    mockResourceServer.buildPaymentRequirements.mockResolvedValue(
      samplePaymentRequirements
    );
    mockResourceServer.findMatchingRequirements.mockReturnValue(
      samplePaymentRequirements[0]
    );
    mockResourceServer.verifyPayment.mockResolvedValue({ isValid: true });

    augmented.paidTool("paid-tool", "Costs money", 0.01, {}, {}, async () => {
      throw new Error("Tool crashed");
    });

    const registeredCb = getRegisteredCallback(server);
    const fakePayload = { scheme: "exact", network: "eip155:84532" };
    const token = btoa(JSON.stringify(fakePayload));

    const result = (await registeredCb(
      {},
      { _meta: { "x402/payment": token } }
    )) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ text: string }>;
    expect(content[0].text).toContain("Tool execution failed");

    // Settlement should NOT have been called
    expect(mockResourceServer.settlePayment).not.toHaveBeenCalled();
  });

  it("returns PRICE_COMPUTE_FAILED when buildPaymentRequirements throws", async () => {
    const server = createMockMcpServer();
    const augmented = withX402(server, defaultServerConfig);

    mockResourceServer.buildPaymentRequirements.mockRejectedValue(
      new Error("facilitator down")
    );

    augmented.paidTool("paid-tool", "Costs money", 0.01, {}, {}, async () => ({
      content: [{ type: "text", text: "result" }]
    }));

    const registeredCb = getRegisteredCallback(server);
    const result = (await registeredCb({}, {})) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, Record<string, unknown>>;
    expect(meta["x402/error"]).toMatchObject({
      x402Version: 2,
      error: "PRICE_COMPUTE_FAILED"
    });
  });

  it("lazy initialization retries on failure", async () => {
    const server = createMockMcpServer();
    const augmented = withX402(server, defaultServerConfig);

    // First call: initialize fails
    mockResourceServer.initialize
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce(undefined);

    mockResourceServer.buildPaymentRequirements.mockResolvedValue(
      samplePaymentRequirements
    );

    augmented.paidTool("paid-tool", "Costs money", 0.01, {}, {}, async () => ({
      content: [{ type: "text", text: "result" }]
    }));

    const registeredCb = getRegisteredCallback(server);

    // First invocation should fail because initialize fails
    await expect(registeredCb({}, {})).rejects.toThrow("network error");
    expect(mockResourceServer.initialize).toHaveBeenCalledTimes(1);

    // Second invocation should succeed (retry initialize)
    const result = (await registeredCb({}, {})) as Record<string, unknown>;
    expect(mockResourceServer.initialize).toHaveBeenCalledTimes(2);
    // It should proceed to return payment required (no token given)
    expect(result.isError).toBe(true);
  });

  it("reads payment token from HTTP headers as fallback", async () => {
    const server = createMockMcpServer();
    const augmented = withX402(server, defaultServerConfig);

    mockResourceServer.buildPaymentRequirements.mockResolvedValue(
      samplePaymentRequirements
    );
    mockResourceServer.findMatchingRequirements.mockReturnValue(
      samplePaymentRequirements[0]
    );
    mockResourceServer.verifyPayment.mockResolvedValue({ isValid: true });
    mockResourceServer.settlePayment.mockResolvedValue({
      success: true,
      transaction: "0xTxHash",
      network: "eip155:84532",
      payer: "0xPayer"
    });

    augmented.paidTool("paid-tool", "Costs money", 0.01, {}, {}, async () => ({
      content: [{ type: "text", text: "ok" }]
    }));

    const registeredCb = getRegisteredCallback(server);
    const fakePayload = { scheme: "exact", network: "eip155:84532" };
    const token = btoa(JSON.stringify(fakePayload));

    // Pass token via HTTP header (PAYMENT-SIGNATURE)
    const result = (await registeredCb(
      {},
      { requestInfo: { headers: { "PAYMENT-SIGNATURE": token } } }
    )) as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
  });

  it("reads payment token from legacy X-PAYMENT header", async () => {
    const server = createMockMcpServer();
    const augmented = withX402(server, defaultServerConfig);

    mockResourceServer.buildPaymentRequirements.mockResolvedValue(
      samplePaymentRequirements
    );
    mockResourceServer.findMatchingRequirements.mockReturnValue(
      samplePaymentRequirements[0]
    );
    mockResourceServer.verifyPayment.mockResolvedValue({ isValid: true });
    mockResourceServer.settlePayment.mockResolvedValue({
      success: true,
      transaction: "0xTxHash",
      network: "eip155:84532",
      payer: "0xPayer"
    });

    augmented.paidTool("paid-tool", "Costs money", 0.01, {}, {}, async () => ({
      content: [{ type: "text", text: "ok" }]
    }));

    const registeredCb = getRegisteredCallback(server);
    const fakePayload = { scheme: "exact", network: "eip155:84532" };
    const token = btoa(JSON.stringify(fakePayload));

    // Pass token via legacy X-PAYMENT header
    const result = (await registeredCb(
      {},
      { requestInfo: { headers: { "X-PAYMENT": token } } }
    )) as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
  });

  it("normalizes legacy network name in config and passes CAIP-2 to resource server", async () => {
    const server = createMockMcpServer();
    const augmented = withX402(server, {
      network: "base-sepolia",
      recipient: "0xABC"
    });

    mockResourceServer.buildPaymentRequirements.mockResolvedValue(
      samplePaymentRequirements
    );

    augmented.paidTool("paid-tool", "Test", 0.01, {}, {}, async () => ({
      content: [{ type: "text" as const, text: "ok" }]
    }));

    const registeredCb = getRegisteredCallback(server);
    await registeredCb({}, {});

    // buildPaymentRequirements should have been called with the CAIP-2 network
    expect(mockResourceServer.buildPaymentRequirements).toHaveBeenCalledWith(
      expect.objectContaining({ network: "eip155:84532" })
    );
  });
});

// =============================================================
// withX402Client (Client side)
// =============================================================
describe("withX402Client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wraps listTools to append payment cost info", async () => {
    const client = createMockMcpClient();
    client.listTools.mockResolvedValue({
      tools: [
        {
          name: "free-tool",
          description: "A free tool",
          _meta: {}
        },
        {
          name: "paid-tool",
          description: "A paid tool",
          _meta: {
            "agents-x402/paymentRequired": true,
            "agents-x402/priceUSD": 0.05
          }
        },
        {
          name: "paid-tool-no-price",
          description: "Another paid tool",
          _meta: {
            "agents-x402/paymentRequired": true
          }
        }
      ]
    });

    const augmented = withX402Client(client, {
      account: mockSigner as unknown as X402ClientConfig["account"]
    });

    const result = await augmented.listTools({}, undefined);

    expect(result.tools[0].description).toBe("A free tool");
    expect(result.tools[1].description).toContain(
      "This is a paid tool, you will be charged $0.05"
    );
    expect(result.tools[2].description).toContain(
      "you will be charged an unknown amount"
    );
  });

  it("passes through non-402 responses unchanged", async () => {
    const client = createMockMcpClient();
    const originalCallTool = client.callTool;
    originalCallTool.mockResolvedValue({
      content: [{ type: "text", text: "Hello!" }]
    });

    const augmented = withX402Client(client, {
      account: mockSigner as unknown as X402ClientConfig["account"]
    });

    const result = await augmented.callTool(null, { name: "hello" });

    expect(result.content).toEqual([{ type: "text", text: "Hello!" }]);
    // callTool should only have been called once (no retry)
    expect(originalCallTool).toHaveBeenCalledOnce();
  });

  it("handles 402 response by creating payment and retrying", async () => {
    const client = createMockMcpClient();
    const originalCallTool = client.callTool;

    // First call returns 402
    originalCallTool
      .mockResolvedValueOnce({
        isError: true,
        _meta: {
          "x402/error": {
            x402Version: 2,
            error: "PAYMENT_REQUIRED",
            resource: {
              url: "x402://test-tool",
              description: "test",
              mimeType: "application/json"
            },
            accepts: samplePaymentRequirements
          }
        },
        content: [{ type: "text", text: "payment required" }]
      })
      // Second call (with payment) succeeds
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Paid result" }]
      });

    mockPaymentClient.createPaymentPayload.mockResolvedValue({
      scheme: "exact",
      network: "eip155:84532",
      signature: "0xSig"
    });

    const augmented = withX402Client(client, {
      account: mockSigner as unknown as X402ClientConfig["account"]
    });

    const result = await augmented.callTool(null, { name: "test-tool" });

    expect(result.content).toEqual([{ type: "text", text: "Paid result" }]);
    expect(originalCallTool).toHaveBeenCalledTimes(2);

    // The retry should include the payment token in _meta
    const retryCall = originalCallTool.mock.calls[1];
    expect(retryCall[0]._meta["x402/payment"]).toBeDefined();
    // The token should be base64-encoded JSON
    const decoded = JSON.parse(atob(retryCall[0]._meta["x402/payment"]));
    expect(decoded.scheme).toBe("exact");
  });

  it("respects maxPaymentValue cap", async () => {
    const client = createMockMcpClient();
    const originalCallTool = client.callTool;

    originalCallTool.mockResolvedValueOnce({
      isError: true,
      _meta: {
        "x402/error": {
          x402Version: 2,
          error: "PAYMENT_REQUIRED",
          resource: {
            url: "x402://expensive",
            description: "expensive",
            mimeType: "application/json"
          },
          accepts: [
            {
              ...samplePaymentRequirements[0],
              amount: "999999999" // Way over the default cap
            }
          ]
        }
      },
      content: [{ type: "text", text: "payment required" }]
    });

    const augmented = withX402Client(client, {
      account: mockSigner as unknown as X402ClientConfig["account"],
      maxPaymentValue: BigInt(100000) // 0.10 USDC
    });

    const result = await augmented.callTool(null, { name: "expensive-tool" });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ text: string }>;
    expect(content[0].text).toContain("Payment exceeds client cap");
    // Should NOT have retried
    expect(originalCallTool).toHaveBeenCalledOnce();
  });

  it("respects confirmation callback declining payment", async () => {
    const client = createMockMcpClient();
    const originalCallTool = client.callTool;

    originalCallTool.mockResolvedValueOnce({
      isError: true,
      _meta: {
        "x402/error": {
          x402Version: 2,
          error: "PAYMENT_REQUIRED",
          resource: {
            url: "x402://test",
            description: "test",
            mimeType: "application/json"
          },
          accepts: samplePaymentRequirements
        }
      },
      content: [{ type: "text", text: "payment required" }]
    });

    const confirmCallback = vi.fn().mockResolvedValue(false);

    const augmented = withX402Client(client, {
      account: mockSigner as unknown as X402ClientConfig["account"]
    });

    const result = await augmented.callTool(confirmCallback, {
      name: "test-tool"
    });

    expect(confirmCallback).toHaveBeenCalledWith(samplePaymentRequirements);
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ text: string }>;
    expect(content[0].text).toBe("User declined payment");
    expect(originalCallTool).toHaveBeenCalledOnce();
  });

  it("uses config confirmationCallback as fallback", async () => {
    const client = createMockMcpClient();

    client.callTool.mockResolvedValueOnce({
      isError: true,
      _meta: {
        "x402/error": {
          x402Version: 2,
          error: "PAYMENT_REQUIRED",
          resource: {
            url: "x402://test",
            description: "test",
            mimeType: "application/json"
          },
          accepts: samplePaymentRequirements
        }
      },
      content: [{ type: "text", text: "payment required" }]
    });

    const configCallback = vi.fn().mockResolvedValue(false);

    const augmented = withX402Client(client, {
      account: mockSigner as unknown as X402ClientConfig["account"],
      confirmationCallback: configCallback
    });

    // Pass null for the per-call callback -> falls back to config callback
    const result = await augmented.callTool(null, { name: "test-tool" });

    expect(configCallback).toHaveBeenCalledWith(samplePaymentRequirements);
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ text: string }>;
    expect(content[0].text).toBe("User declined payment");
  });

  it("returns error when payment payload creation fails", async () => {
    const client = createMockMcpClient();

    client.callTool.mockResolvedValueOnce({
      isError: true,
      _meta: {
        "x402/error": {
          x402Version: 2,
          error: "PAYMENT_REQUIRED",
          resource: {
            url: "x402://test",
            description: "test",
            mimeType: "application/json"
          },
          accepts: samplePaymentRequirements
        }
      },
      content: [{ type: "text", text: "payment required" }]
    });

    mockPaymentClient.createPaymentPayload.mockRejectedValue(
      new Error("signing failed")
    );

    const augmented = withX402Client(client, {
      account: mockSigner as unknown as X402ClientConfig["account"]
    });

    const result = await augmented.callTool(null, { name: "test-tool" });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ text: string }>;
    expect(content[0].text).toBe("Failed to create payment payload");
  });

  it("registers a network preference policy when network is provided", () => {
    const client = createMockMcpClient();

    withX402Client(client, {
      account: mockSigner as unknown as X402ClientConfig["account"],
      network: "base-sepolia"
    });

    expect(mockPaymentClient.registerPolicy).toHaveBeenCalledOnce();
    const policyFn = mockPaymentClient.registerPolicy.mock.calls[0][0];

    // Policy should filter to matching network
    const filtered = policyFn(2, [
      { network: "eip155:84532", scheme: "exact" },
      { network: "eip155:1", scheme: "exact" }
    ]);
    expect(filtered).toEqual([{ network: "eip155:84532", scheme: "exact" }]);

    // Policy should return all if none match
    const noMatch = policyFn(2, [{ network: "eip155:999", scheme: "exact" }]);
    expect(noMatch).toEqual([{ network: "eip155:999", scheme: "exact" }]);
  });

  it("does not register a policy when network is not provided", () => {
    const client = createMockMcpClient();

    withX402Client(client, {
      account: mockSigner as unknown as X402ClientConfig["account"]
    });

    expect(mockPaymentClient.registerPolicy).not.toHaveBeenCalled();
  });

  it("accepts deprecated version field without error", () => {
    const client = createMockMcpClient();

    // Should not throw even with the deprecated version field
    expect(() =>
      withX402Client(client, {
        account: mockSigner as unknown as X402ClientConfig["account"],
        version: 1
      })
    ).not.toThrow();
  });
});
