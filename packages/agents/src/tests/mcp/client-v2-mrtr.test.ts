import {
  McpServer,
  acceptedContent,
  createMcpHandler,
  inputRequired,
  type CallToolResult,
  type GetPromptResult,
  type InputRequiredResult,
  type ReadResourceResult,
  type ServerContext
} from "@modelcontextprotocol/server";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MCPClientConnection } from "../../mcp/client-connection";
import { MCPClientManager } from "../../mcp/client";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function statelessServer() {
  const server = new McpServer({ name: "stateless-test", version: "1.0.0" });
  server.registerTool(
    "ask",
    { inputSchema: z.object({}) },
    async (_args, context): Promise<CallToolResult | InputRequiredResult> => {
      const accepted = acceptedContent<{ answer: string }>(
        context.mcpReq.inputResponses,
        "answer"
      );
      if (!accepted) {
        return inputRequired({
          inputRequests: {
            answer: inputRequired.elicit({
              message: "Answer the question",
              requestedSchema: {
                type: "object",
                properties: { answer: { type: "string" } },
                required: ["answer"]
              }
            })
          }
        });
      }
      return {
        content: [{ type: "text", text: accepted.answer }]
      };
    }
  );
  server.registerPrompt(
    "ask-prompt",
    {},
    async (context): Promise<GetPromptResult | InputRequiredResult> => {
      const promptContext = acceptedContent<{ answer: string }>(
        (context as ServerContext).mcpReq.inputResponses,
        "answer"
      )?.answer;
      if (!promptContext) {
        return inputRequired({
          inputRequests: {
            answer: inputRequired.elicit({
              message: "Prompt context",
              requestedSchema: {
                type: "object",
                properties: { answer: { type: "string" } },
                required: ["answer"]
              }
            })
          }
        });
      }
      return {
        messages: [
          { role: "user", content: { type: "text", text: promptContext } }
        ]
      };
    }
  );
  server.registerResource(
    "ask-resource",
    "test://ask",
    {},
    async (uri, context): Promise<ReadResourceResult | InputRequiredResult> => {
      const resourceText = acceptedContent<{ answer: string }>(
        context.mcpReq.inputResponses,
        "answer"
      )?.answer;
      if (!resourceText) {
        return inputRequired({
          inputRequests: {
            answer: inputRequired.elicit({
              message: "Resource content",
              requestedSchema: {
                type: "object",
                properties: { answer: { type: "string" } },
                required: ["answer"]
              }
            })
          }
        });
      }
      return { contents: [{ uri: uri.href, text: resourceText }] };
    }
  );
  return server;
}

describe("MCP v2 client MRTR", () => {
  it("keeps callTool pending while SDK auto-fulfils input_required", async () => {
    const gate = deferred<{ action: "accept"; content: { answer: string } }>();
    const handler = createMcpHandler(() => statelessServer());
    const methods: string[] = [];
    const connection = new MCPClientConnection(
      new URL("https://example.com/mcp"),
      { name: "agents-test", version: "1.0.0" },
      {
        client: {},
        transport: {
          type: "streamable-http",
          fetch: async (input, init) => {
            const request = new Request(input, init);
            const body = (await request.clone().json()) as { method?: string };
            if (body.method) methods.push(body.method);
            return handler.fetch(request);
          }
        },
        elicitationHandlers: { form: async () => gate.promise }
      }
    );

    expect(await connection.init()).toBeUndefined();
    expect(connection.client.getProtocolEra()).toBe("modern");
    expect(methods[0]).toBe("server/discover");
    expect(methods).not.toContain("initialize");

    let settled = false;
    const resultPromise = connection.client
      .callTool({ name: "ask", arguments: {} })
      .finally(() => (settled = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.resolve({ action: "accept", content: { answer: "accepted" } });
    await expect(resultPromise).resolves.toMatchObject({
      content: [{ type: "text", text: "accepted" }]
    });
  });

  it("keeps prompt and resource requests pending during auto-fulfilment", async () => {
    const promptGate = deferred<{
      action: "accept";
      content: { answer: string };
    }>();
    const resourceGate = deferred<{
      action: "accept";
      content: { answer: string };
    }>();
    let handlerCalls = 0;
    const handler = createMcpHandler(() => statelessServer());
    const connection = new MCPClientConnection(
      new URL("https://example.com/mcp"),
      { name: "agents-test", version: "1.0.0" },
      {
        client: {},
        transport: {
          type: "streamable-http",
          fetch: async (input, init) => handler.fetch(new Request(input, init))
        },
        elicitationHandlers: {
          form: async () =>
            (handlerCalls++ === 0 ? promptGate : resourceGate).promise
        }
      }
    );
    expect(await connection.init()).toBeUndefined();

    let promptSettled = false;
    const prompt = connection.client
      .getPrompt({ name: "ask-prompt" })
      .finally(() => (promptSettled = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(promptSettled).toBe(false);
    promptGate.resolve({ action: "accept", content: { answer: "prompt" } });
    await expect(prompt).resolves.toMatchObject({
      messages: [{ content: { type: "text", text: "prompt" } }]
    });

    let resourceSettled = false;
    const resource = connection.client
      .readResource({ uri: "test://ask" })
      .finally(() => (resourceSettled = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(resourceSettled).toBe(false);
    resourceGate.resolve({
      action: "accept",
      content: { answer: "resource" }
    });
    await expect(resource).resolves.toMatchObject({
      contents: [{ text: "resource" }]
    });
  });

  it("aborts a pending elicitation handler with the originating call", async () => {
    const gate = deferred<{ action: "accept"; content: { answer: string } }>();
    const handler = createMcpHandler(() => statelessServer());
    const connection = new MCPClientConnection(
      new URL("https://example.com/mcp"),
      { name: "agents-test", version: "1.0.0" },
      {
        client: {},
        transport: {
          type: "streamable-http",
          fetch: async (input, init) => handler.fetch(new Request(input, init))
        },
        elicitationHandlers: { form: async () => gate.promise }
      }
    );
    expect(await connection.init()).toBeUndefined();
    const controller = new AbortController();
    const result = connection.client.callTool(
      { name: "ask", arguments: {} },
      { signal: controller.signal }
    );
    await Promise.resolve();
    controller.abort(new Error("cancelled by test"));
    await expect(result).rejects.toThrow("cancelled by test");
  });

  it("forwards manager options and strips serverId from every operation", async () => {
    const client = {
      callTool: async (...args: unknown[]) => args,
      request: async (...args: unknown[]) => args,
      getPrompt: async (...args: unknown[]) => args,
      readResource: async (...args: unknown[]) => args
    };
    const manager = Object.create(
      MCPClientManager.prototype
    ) as MCPClientManager;
    manager.mcpConnections = {
      server: { client } as unknown as MCPClientConnection
    };
    const options = { timeout: 123, maxTotalTimeout: 456 };

    await expect(
      manager.callTool(
        { serverId: "server", name: "server.tool", arguments: {} },
        options
      )
    ).resolves.toEqual([{ name: "tool", arguments: {} }, options]);
    await expect(
      manager.callTool(
        { serverId: "server", name: "server.legacy", arguments: {} },
        CallToolResultSchema,
        options
      )
    ).resolves.toEqual([
      { method: "tools/call", params: { name: "legacy", arguments: {} } },
      CallToolResultSchema,
      options
    ]);
    await expect(
      manager.getPrompt({ serverId: "server", name: "prompt" }, options)
    ).resolves.toEqual([{ name: "prompt" }, options]);
    await expect(
      manager.readResource(
        { serverId: "server", uri: "test://resource" },
        options
      )
    ).resolves.toEqual([{ uri: "test://resource" }, options]);
  });

  it("restores Stateless negotiation state before resuming a saved session", async () => {
    const handler = createMcpHandler(() => statelessServer());
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) =>
      handler.fetch(new Request(input, init));
    const first = new MCPClientConnection(
      new URL("https://example.com/mcp"),
      { name: "agents-test", version: "1.0.0" },
      { client: {}, transport: { type: "streamable-http", fetch } }
    );
    expect(await first.init()).toBeUndefined();
    const prior = first.discoverResult;
    expect(prior).toBeDefined();

    const methods: Array<{ method?: string; hasMeta: boolean }> = [];
    const restored = new MCPClientConnection(
      new URL("https://example.com/mcp"),
      { name: "agents-test", version: "1.0.0" },
      {
        client: {},
        discoverResult: prior,
        transport: {
          type: "streamable-http",
          sessionId: "saved-session",
          protocolVersion: "2026-07-28",
          fetch: async (input, init) => {
            const request = new Request(input, init);
            if (request.method === "POST") {
              const body = (await request.clone().json()) as {
                method?: string;
                params?: { _meta?: unknown };
              };
              methods.push({
                method: body.method,
                hasMeta: body.params?._meta !== undefined
              });
            }
            return handler.fetch(request);
          }
        }
      }
    );

    expect(await restored.init()).toBeUndefined();
    expect(restored.client.getProtocolEra()).toBe("modern");
    await restored.client.listTools();
    expect(methods).toContainEqual({ method: "tools/list", hasMeta: true });
  });

  it("preserves explicit negotiation and input-required options", () => {
    const connection = new MCPClientConnection(
      new URL("https://example.com/mcp"),
      { name: "agents-test", version: "1.0.0" },
      {
        transport: { type: "streamable-http" },
        client: {
          versionNegotiation: { mode: "legacy" },
          inputRequired: { autoFulfill: false }
        }
      }
    );
    const internals = connection.client as unknown as {
      _versionNegotiation: unknown;
      _inputRequiredDriverConfig: { autoFulfill: boolean };
    };
    expect(internals._versionNegotiation).toEqual({ mode: "legacy" });
    expect(internals._inputRequiredDriverConfig.autoFulfill).toBe(false);
  });
});
