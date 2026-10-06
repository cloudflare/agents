/**
 * End-to-end payment extraction against real MCP SDK servers and transports.
 *
 * `paidTool` reads the payment from the tool handler's second argument, whose
 * shape differs between SDK v1 (`extra._meta`, `extra.requestInfo.headers`)
 * and SDK v2 (`ctx.mcpReq._meta`, `ctx.http.req.headers`). These tests drive
 * a real client against a real server so the shape is whatever the SDK
 * actually produces, not a hand-built stand-in. Only the x402 facilitator is
 * mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Client as V2Client,
  InMemoryTransport as V2InMemoryTransport,
  StreamableHTTPClientTransport as V2HttpClientTransport
} from "@modelcontextprotocol/client";
import {
  createMcpHandler as createV2McpHandler,
  McpServer as V2McpServer
} from "@modelcontextprotocol/server";
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as V1HttpClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport as V1InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer as V1McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport as V1HttpServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const requirement = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "10000",
  asset: "0xSomeToken",
  payTo: "0xRecipient",
  maxTimeoutSeconds: 300
};

const mockResourceServer = {
  initialize: vi.fn(),
  buildPaymentRequirements: vi.fn(),
  findMatchingRequirements: vi.fn(),
  verifyPayment: vi.fn(),
  settlePayment: vi.fn()
};

vi.mock("@x402/core/server", () => ({
  x402ResourceServer: vi.fn(function () {
    return mockResourceServer;
  }),
  HTTPFacilitatorClient: vi.fn(function () {})
}));

vi.mock("@x402/evm/exact/server", () => ({
  registerExactEvmScheme: vi.fn()
}));

import { withX402, type X402Config } from "../mcp/client/x402";

const config: X402Config = {
  network: "base-sepolia",
  recipient: "0xRecipient"
};

const paymentPayload = { x402Version: 2, scheme: "exact", payload: {} };
const token = btoa(JSON.stringify(paymentPayload));

type ToolResult = {
  isError?: boolean;
  content?: unknown;
  _meta?: Record<string, unknown>;
};

function x402Error(result: ToolResult): string | undefined {
  return (result._meta?.["x402/error"] as { error?: string } | undefined)
    ?.error;
}

function paymentResponse(result: ToolResult): unknown {
  return result._meta?.["x402/payment-response"];
}

// The tool body records the handler context it was given so tests can check
// paidTool forwards the SDK's own context object unchanged.
let seenContexts: unknown[] = [];

// Registered separately per SDK so the public types are exercised for each:
// the v2 callback context is the v2 ServerContext, the v1 one RequestHandlerExtra.
function registerV2PaidTool(server: V2McpServer) {
  return withX402(server, config).paidTool(
    "echo",
    "Echoes a message",
    0.01,
    { message: z.string() },
    {},
    async ({ message }, ctx) => {
      seenContexts.push(ctx);
      expect(ctx.mcpReq.method).toBe("tools/call");
      return { content: [{ type: "text", text: `echo: ${message}` }] };
    }
  );
}

function registerV1PaidTool(server: V1McpServer) {
  return withX402(server, config).paidTool(
    "echo",
    "Echoes a message",
    0.01,
    { message: z.string() },
    {},
    async ({ message }, extra) => {
      seenContexts.push(extra);
      expect(typeof extra.sendNotification).toBe("function");
      return { content: [{ type: "text", text: `echo: ${message}` }] };
    }
  );
}

async function connectV2InMemory() {
  const server = new V2McpServer({ name: "x402-v2", version: "1.0.0" });
  registerV2PaidTool(server);
  const client = new V2Client({ name: "client", version: "1.0.0" });
  const [serverSide, clientSide] = V2InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

async function connectV1InMemory() {
  const server = new V1McpServer({ name: "x402-v1", version: "1.0.0" });
  registerV1PaidTool(server);
  const client = new V1Client({ name: "client", version: "1.0.0" });
  const [serverSide, clientSide] = V1InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

/** A v2 client talking HTTP to a v2 `createMcpHandler`, with extra headers. */
async function connectV2Http(headers: Record<string, string>) {
  const handler = createV2McpHandler(() => {
    const server = new V2McpServer({ name: "x402-v2", version: "1.0.0" });
    registerV2PaidTool(server);
    return server;
  });
  const client = new V2Client({ name: "client", version: "1.0.0" });
  await client.connect(
    new V2HttpClientTransport(new URL("http://localhost/mcp"), {
      requestInit: { headers },
      fetch: (input, init) => handler.fetch(new Request(input, init))
    })
  );
  return client;
}

/** A v1 client talking HTTP to a stateless v1 server, with extra headers. */
async function connectV1Http(headers: Record<string, string>) {
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    // Stateless v1 transports serve exactly one request each.
    const server = new V1McpServer({ name: "x402-v1", version: "1.0.0" });
    registerV1PaidTool(server);
    const transport = new V1HttpServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    await server.connect(transport);
    return transport.handleRequest(new Request(input, init));
  };
  const client = new V1Client({ name: "client", version: "1.0.0" });
  await client.connect(
    new V1HttpClientTransport(new URL("http://localhost/mcp"), {
      requestInit: { headers },
      fetch: fetchImpl
    })
  );
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  seenContexts = [];
  mockResourceServer.initialize.mockResolvedValue(undefined);
  mockResourceServer.buildPaymentRequirements.mockResolvedValue([requirement]);
  mockResourceServer.findMatchingRequirements.mockReturnValue(requirement);
  mockResourceServer.verifyPayment.mockResolvedValue({ isValid: true });
  mockResourceServer.settlePayment.mockResolvedValue({
    success: true,
    transaction: "0xTxHash",
    network: "eip155:84532",
    payer: "0xPayer"
  });
});

function expectPaidAndSettled(result: ToolResult) {
  expect(x402Error(result)).toBeUndefined();
  expect(result.isError).toBeFalsy();
  expect(result.content).toEqual([{ type: "text", text: "echo: hi" }]);
  expect(paymentResponse(result)).toMatchObject({
    success: true,
    transaction: "0xTxHash"
  });
  // The exact token the client sent reached verification and settlement.
  expect(mockResourceServer.verifyPayment).toHaveBeenCalledWith(
    paymentPayload,
    requirement
  );
  expect(mockResourceServer.settlePayment).toHaveBeenCalledWith(
    paymentPayload,
    requirement
  );
}

describe("withX402 on an SDK v2 McpServer", () => {
  it("returns PAYMENT_REQUIRED when no payment is sent", async () => {
    const client = await connectV2InMemory();
    const result = (await client.callTool({
      name: "echo",
      arguments: { message: "hi" }
    })) as ToolResult;

    expect(result.isError).toBe(true);
    expect(x402Error(result)).toBe("PAYMENT_REQUIRED");
    expect(mockResourceServer.verifyPayment).not.toHaveBeenCalled();
  });

  it("reads the payment from request _meta", async () => {
    const client = await connectV2InMemory();
    const result = (await client.callTool({
      name: "echo",
      arguments: { message: "hi" },
      _meta: { "x402/payment": token }
    })) as ToolResult;

    expectPaidAndSettled(result);
    // The tool body gets the SDK's own v2 context, untouched.
    expect(seenContexts).toHaveLength(1);
    expect(seenContexts[0]).toHaveProperty("mcpReq");
  });

  it("decodes a malformed _meta payment instead of ignoring it", async () => {
    const client = await connectV2InMemory();
    const result = (await client.callTool({
      name: "echo",
      arguments: { message: "hi" },
      _meta: { "x402/payment": "not-base64-json!@#" }
    })) as ToolResult;

    expect(x402Error(result)).toBe("INVALID_PAYMENT");
  });

  it.each([
    ["PAYMENT-SIGNATURE"],
    ["Payment-Signature"],
    ["payment-signature"],
    ["X-PAYMENT"],
    ["X-Payment"]
  ])("reads the payment from the %s HTTP header", async (header) => {
    const client = await connectV2Http({ [header]: token });
    const result = (await client.callTool({
      name: "echo",
      arguments: { message: "hi" }
    })) as ToolResult;

    expectPaidAndSettled(result);
  });

  it("prefers the _meta payment over a payment header", async () => {
    const client = await connectV2Http({ "PAYMENT-SIGNATURE": "not-a-token" });
    const result = (await client.callTool({
      name: "echo",
      arguments: { message: "hi" },
      _meta: { "x402/payment": token }
    })) as ToolResult;

    expectPaidAndSettled(result);
  });

  it("still returns PAYMENT_REQUIRED over HTTP without a payment", async () => {
    const client = await connectV2Http({});
    const result = (await client.callTool({
      name: "echo",
      arguments: { message: "hi" }
    })) as ToolResult;

    expect(x402Error(result)).toBe("PAYMENT_REQUIRED");
  });
});

describe("withX402 on an SDK v1 McpServer", () => {
  it("returns PAYMENT_REQUIRED when no payment is sent", async () => {
    const client = await connectV1InMemory();
    const result = (await client.callTool({
      name: "echo",
      arguments: { message: "hi" }
    })) as ToolResult;

    expect(x402Error(result)).toBe("PAYMENT_REQUIRED");
  });

  it("reads the payment from request _meta", async () => {
    const client = await connectV1InMemory();
    const result = (await client.callTool({
      name: "echo",
      arguments: { message: "hi" },
      _meta: { "x402/payment": token }
    })) as ToolResult;

    expectPaidAndSettled(result);
    expect(seenContexts).toHaveLength(1);
    expect(seenContexts[0]).toHaveProperty("sendNotification");
  });

  it.each([
    ["PAYMENT-SIGNATURE"],
    ["Payment-Signature"],
    ["X-PAYMENT"],
    ["x-payment"]
  ])("reads the payment from the %s HTTP header", async (header) => {
    const client = await connectV1Http({ [header]: token });
    const result = (await client.callTool({
      name: "echo",
      arguments: { message: "hi" }
    })) as ToolResult;

    expectPaidAndSettled(result);
  });

  it("prefers the _meta payment over a payment header", async () => {
    const client = await connectV1Http({ "PAYMENT-SIGNATURE": "not-a-token" });
    const result = (await client.callTool({
      name: "echo",
      arguments: { message: "hi" },
      _meta: { "x402/payment": token }
    })) as ToolResult;

    expectPaidAndSettled(result);
  });
});
