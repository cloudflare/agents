import {
  Client,
  StreamableHTTPClientTransport
} from "@modelcontextprotocol/client";
import {
  McpServer,
  inputRequired,
  type ServerContext
} from "@modelcontextprotocol/server";
import { isPaymentRequired } from "@x402/core/schemas";
import type { PaymentRequired } from "@x402/core/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMcpHandler } from "../mcp/server";
import { withX402 } from "../payments/x402/mcp";
import { paymentFixture } from "./paid-tool-fixture";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(register: (server: McpServer) => void) {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "paid-tools-test", version: "1.0.0" });
    const original = server.registerTool;
    register(server);
    expect(server.registerTool).toBe(original);
    expect("paidTool" in server).toBe(false);
    return server;
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://tools.test/mcp"), {
      fetch: (input, init) => handler.fetch(new Request(input, init))
    })
  );
  return client;
}

describe("paid tool callbacks over MCP SDK v2", () => {
  it("challenges, verifies, executes, and preserves schemas, context, result metadata and receipts", async () => {
    const { config, sign, verify, settle } = await paymentFixture();
    const execute = vi.fn();
    const inputSchema = z.object({ number: z.number() });
    const client = await connect((server) => {
      server.registerTool(
        "square",
        {
          inputSchema,
          outputSchema: z.object({ value: z.number() }),
          _meta: { custom: "tool metadata" }
        },
        withX402<typeof inputSchema>(async ({ number }, context) => {
          execute(context.mcpReq._meta?.trace);
          return {
            content: [{ type: "text", text: String(number ** 2) }],
            structuredContent: { value: number ** 2 },
            _meta: { custom: "result metadata" }
          };
        }, config)
      );
    });
    expect((await client.listTools()).tools[0]._meta?.custom).toBe(
      "tool metadata"
    );
    const params = { name: "square", arguments: { number: 5 } };
    const challenge = await client.callTool(params);
    expect(challenge.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(isPaymentRequired(challenge.structuredContent)).toBe(true);
    if (
      !isPaymentRequired(challenge.structuredContent) ||
      challenge.structuredContent.x402Version !== 2
    )
      throw new Error("Missing v2 challenge");
    const payment = await sign(challenge.structuredContent as PaymentRequired);
    const result = await client.callTool({
      ...params,
      _meta: { trace: "preserved", "x402/payment": payment }
    });
    expect(result.structuredContent).toEqual({ value: 25 });
    expect(result._meta).toMatchObject({
      custom: "result metadata",
      "x402/payment-response": { success: true, transaction: "0xtransaction" }
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith("preserved");
    expect(verify).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledOnce();
  });

  it("supports callbacks without an input schema", async () => {
    const { config, payment, settle } = await paymentFixture();
    const client = await connect((server) => {
      server.registerTool(
        "hello",
        {},
        withX402<undefined>(
          async (context) => ({
            content: [
              { type: "text", text: String(context.mcpReq._meta?.trace) }
            ]
          }),
          config
        )
      );
    });
    const result = await client.callTool({
      name: "hello",
      _meta: { trace: "hello", "x402/payment": payment }
    });
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    expect(settle).toHaveBeenCalledOnce();
  });

  it("does not settle an MCP error result", async () => {
    const { config, payment, settle } = await paymentFixture();
    const client = await connect((server) => {
      server.registerTool(
        "failed",
        {},
        withX402<undefined>(
          async () => ({
            isError: true,
            content: [{ type: "text", text: "Tool failed" }]
          }),
          config
        )
      );
    });
    const result = await client.callTool({
      name: "failed",
      _meta: { "x402/payment": payment }
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Tool failed" }]);
    expect(settle).not.toHaveBeenCalled();
  });

  it("returns settlement failure without a new payment challenge or the paid result", async () => {
    const { config, payment, settle } = await paymentFixture();
    settle.mockResolvedValueOnce({
      success: false,
      errorReason: "failed",
      transaction: "",
      network: "eip155:84532"
    });
    const client = await connect((server) => {
      server.registerTool(
        "result",
        {},
        withX402<undefined>(
          async () => ({
            content: [{ type: "text", text: "Paid data" }]
          }),
          config
        )
      );
    });
    const result = await client.callTool({
      name: "result",
      _meta: { "x402/payment": payment }
    });
    expect(result.isError).toBe(true);
    expect(isPaymentRequired(result.structuredContent)).toBe(false);
    expect(result.content).toEqual([
      { type: "text", text: "Payment settlement failed: failed" }
    ]);
    expect(result._meta?.["x402/payment-response"]).toMatchObject({
      success: false
    });
  });

  it("does not execute on invalid payment metadata", async () => {
    const { config, verify, settle } = await paymentFixture();
    const execute = vi.fn(async () => ({ content: [] }));
    const client = await connect((server) => {
      server.registerTool("result", {}, withX402<undefined>(execute, config));
    });
    const result = await client.callTool({
      name: "result",
      _meta: { "x402/payment": { malformed: true } }
    });
    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("does not settle an intermediate multi-round-trip result", async () => {
    const { config, payment, settle } = await paymentFixture();
    const callback = withX402<undefined>(
      async () => inputRequired({ requestState: "continue" }),
      config
    );
    // Inspect the intermediate callback result directly, before client automatic MRTR.
    const context = {
      mcpReq: {
        signal: new AbortController().signal,
        _meta: { "x402/payment": payment }
      }
    } as unknown as ServerContext;
    expect((await callback(context)).resultType).toBe("input_required");
    expect(settle).not.toHaveBeenCalled();
  });

  it("does not execute or settle when verification finishes after cancellation", async () => {
    const { config, payment, verify, settle } = await paymentFixture();
    const controller = new AbortController();
    verify.mockImplementationOnce(async () => {
      controller.abort(new Error("Cancelled"));
      return { isValid: true };
    });
    const execute = vi.fn(async () => ({ content: [] }));
    const callback = withX402<undefined>(execute, config);
    const context = {
      mcpReq: {
        signal: controller.signal,
        _meta: { "x402/payment": payment }
      }
    } as unknown as ServerContext;
    await expect(callback(context)).rejects.toThrow("Cancelled");
    expect(execute).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });
});
