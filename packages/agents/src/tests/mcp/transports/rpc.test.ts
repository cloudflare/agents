import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RPCClientTransport, RPCServerTransport } from "../../../mcp/rpc";
import type {
  JSONRPCMessage,
  JSONRPCRequest
} from "@modelcontextprotocol/sdk/types.js";
import {
  TEST_MESSAGES,
  establishRPCConnection,
  expectValidToolsList,
  expectValidGreetResult
} from "../../shared/test-utils";
import type { McpAgent } from "../../../mcp";

describe("RPC Transport", () => {
  describe("RPCClientTransport", () => {
    it("should start and close transport", async () => {
      const transport = new RPCClientTransport({
        namespace: env.MCP_OBJECT,
        name: "test-start-close"
      });

      await transport.start();

      let closeCalled = false;
      transport.onclose = () => {
        closeCalled = true;
      };

      await transport.close();
      expect(closeCalled).toBe(true);
    });

    it("should throw error when sending before start", async () => {
      const transport = new RPCClientTransport({
        namespace: env.MCP_OBJECT,
        name: "test-send-before-start"
      });

      const message: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: 1,
        method: "test",
        params: {}
      };

      await expect(transport.send(message)).rejects.toThrow(
        "Transport not started"
      );
    });

    it("should throw error when starting twice", async () => {
      const transport = new RPCClientTransport({
        namespace: env.MCP_OBJECT,
        name: "test-double-start"
      });

      await transport.start();
      await expect(transport.start()).rejects.toThrow(
        "Transport already started"
      );
    });

    it("should send initialize message and receive response", async () => {
      const transport = new RPCClientTransport({
        namespace: env.MCP_OBJECT,
        name: `test-init-${crypto.randomUUID()}`
      });
      await transport.start();

      const receivedMessages: JSONRPCMessage[] = [];
      transport.onmessage = (msg) => {
        receivedMessages.push(msg);
      };

      await transport.send(TEST_MESSAGES.initialize);

      expect(receivedMessages.length).toBeGreaterThan(0);
      const response = receivedMessages[0];
      expect(response).toHaveProperty("result");
    });

    it("should return JSON-RPC error for invalid messages", async () => {
      const transport = new RPCClientTransport({
        namespace: env.MCP_OBJECT,
        name: "test-invalid-msg"
      });
      await transport.start();

      const invalidMessage = {
        jsonrpc: "1.0",
        id: 1,
        method: "test"
      } as unknown as JSONRPCMessage;

      const received: JSONRPCMessage[] = [];
      transport.onmessage = (msg) => {
        received.push(msg);
      };

      await transport.send(invalidMessage);

      expect(received.length).toBe(1);
      expect(received[0]).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32600,
          message: "Invalid Request"
        }
      });
    });

    it("should call onclose when closing", async () => {
      const transport = new RPCClientTransport({
        namespace: env.MCP_OBJECT,
        name: "test-onclose"
      });
      await transport.start();

      let closeCalled = false;
      transport.onclose = () => {
        closeCalled = true;
      };

      await transport.close();
      expect(closeCalled).toBe(true);
    });
  });

  describe("RPCServerTransport", () => {
    it("should start and close transport", async () => {
      const transport = new RPCServerTransport();

      await transport.start();

      let closeCalled = false;
      transport.onclose = () => {
        closeCalled = true;
      };

      await transport.close();
      expect(closeCalled).toBe(true);
    });

    it("should handle request and return response", async () => {
      const transport = new RPCServerTransport();
      await transport.start();

      const expectedResponse: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: 1,
        result: { success: true }
      };

      transport.onmessage = (msg) => {
        expect(msg).toEqual({
          jsonrpc: "2.0",
          id: 1,
          method: "test",
          params: {}
        });
      };

      const handlePromise = transport.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "test",
        params: {}
      });

      await transport.send(expectedResponse);

      const result = await handlePromise;
      expect(result).toEqual(expectedResponse);
    });

    it("should not resolve a request with another request's earlier response", async () => {
      const transport = new RPCServerTransport();
      await transport.start();

      transport.onmessage = (msg) => {
        const req = msg as JSONRPCRequest;
        if (req.id === 1) return;
        void transport.send({
          jsonrpc: "2.0",
          id: req.id,
          result: { method: req.method }
        });
      };

      const first = transport.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "first",
        params: {}
      });
      const second = transport.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "second",
        params: {}
      });

      await expect(second).resolves.toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: { method: "second" }
      });

      await transport.send({
        jsonrpc: "2.0",
        id: 1,
        result: { method: "first" }
      });
      await expect(first).resolves.toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: { method: "first" }
      });
    });

    it("should route overlapping responses by request id", async () => {
      const transport = new RPCServerTransport();
      await transport.start();

      transport.onmessage = (msg) => {
        const req = msg as JSONRPCRequest;
        setTimeout(
          () => {
            void transport.send({
              jsonrpc: "2.0",
              id: req.id,
              result: { method: req.method }
            });
          },
          req.method === "first" ? 20 : 0
        );
      };

      const first = transport.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "first",
        params: {}
      });
      const second = transport.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "second",
        params: {}
      });

      await expect(second).resolves.toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: { method: "second" }
      });
      await expect(first).resolves.toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: { method: "first" }
      });
    });

    it("should route related server requests to the originating request", async () => {
      const transport = new RPCServerTransport();
      await transport.start();

      const elicitationRequest: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: "elicit_1",
        method: "elicitation/create",
        params: { message: "Approve?" }
      };

      transport.onmessage = (msg) => {
        const req = msg as JSONRPCRequest;
        void transport.send(elicitationRequest, { relatedRequestId: req.id });
      };

      await expect(
        transport.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {}
        })
      ).resolves.toEqual(elicitationRequest);
    });

    it("should include related notifications before the final response", async () => {
      const transport = new RPCServerTransport();
      await transport.start();

      const notification: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level: "info", data: "hello" }
      };
      const finalResponse: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: 1,
        result: { ok: true }
      };

      transport.onmessage = (msg) => {
        const req = msg as JSONRPCRequest;
        void transport.send(notification, { relatedRequestId: req.id });
        void transport.send(finalResponse);
      };

      await expect(
        transport.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {}
        })
      ).resolves.toEqual([notification, finalResponse]);
    });

    it("should handle notification without waiting for response", async () => {
      const transport = new RPCServerTransport();
      await transport.start();

      let messageReceived = false;
      transport.onmessage = () => {
        messageReceived = true;
      };

      const result = await transport.handle({
        jsonrpc: "2.0",
        method: "notification",
        params: {}
      });

      expect(messageReceived).toBe(true);
      expect(result).toBeUndefined();
    });

    it("should throw error when handling before start", async () => {
      const transport = new RPCServerTransport();

      await expect(
        transport.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "test",
          params: {}
        })
      ).rejects.toThrow("Transport not started");
    });

    it("should throw error when sending before start", async () => {
      const transport = new RPCServerTransport();

      await expect(
        transport.send({
          jsonrpc: "2.0",
          id: 1,
          result: {}
        })
      ).rejects.toThrow("Transport not started");
    });

    it("should call onclose when closing", async () => {
      const transport = new RPCServerTransport();
      await transport.start();

      let closeCalled = false;
      transport.onclose = () => {
        closeCalled = true;
      };

      await transport.close();
      expect(closeCalled).toBe(true);
    });

    it("should timeout when onmessage handler never calls send()", async () => {
      const transport = new RPCServerTransport({ timeout: 50 });
      await transport.start();

      transport.onmessage = () => {
        // deliberately never call send()
      };

      await expect(
        transport.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "slow",
          params: {}
        })
      ).rejects.toThrow("Request timeout: No response received within 50ms");
    });

    it("should resolve _awaitPendingResponse when send() is called after handle() returns", async () => {
      const transport = new RPCServerTransport();
      await transport.start();

      const firstResponse: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: "elicit_abc",
        method: "elicitation/create",
        params: { message: "Approve?" }
      };

      const finalResponse: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "done" }] }
      };

      // Simulate: onmessage dispatches async tool handler that sends
      // an intermediate server-to-client request first. In the MCP SDK this
      // is sent with relatedRequestId so it routes to the originating request.
      transport.onmessage = (msg) => {
        const req = msg as JSONRPCRequest;
        void transport.send(firstResponse, { relatedRequestId: req.id });
      };

      // handle() returns the intermediate elicitation request
      const handleResult = await transport.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "test" }
      });

      expect(handleResult).toEqual(firstResponse);

      // Now await the next send() — simulates waiting for the resumed tool result
      const pendingPromise = transport._awaitPendingResponse();

      // Tool handler resumes and sends the final result for the original request id
      await transport.send(finalResponse);

      const result = await pendingPromise;
      expect(result).toEqual(finalResponse);
    });

    it("should keep an id-routed response from completing a continuation", async () => {
      const transport = new RPCServerTransport();
      await transport.start();

      const continuation = transport._awaitPendingResponse();
      const request = transport.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {}
      });

      await transport.send({
        jsonrpc: "2.0",
        id: 1,
        result: { routed: true }
      });
      await expect(request).resolves.toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: { routed: true }
      });

      await transport.send({
        jsonrpc: "2.0",
        id: 2,
        result: { continuation: true }
      });
      await expect(continuation).resolves.toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: { continuation: true }
      });
    });

    it("should reject all pending request waiters on close", async () => {
      const transport = new RPCServerTransport();
      await transport.start();

      const first = expect(
        transport.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "slow-one",
          params: {}
        })
      ).rejects.toThrow("Transport closed");
      const second = expect(
        transport.handle({
          jsonrpc: "2.0",
          id: 2,
          method: "slow-two",
          params: {}
        })
      ).rejects.toThrow("Transport closed");

      await transport.close();

      await first;
      await second;
    });

    it("should reject pending waiters on close", async () => {
      const transport = new RPCServerTransport();
      await transport.start();

      const request = expect(
        transport.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "slow",
          params: {}
        })
      ).rejects.toThrow("Transport closed");
      const continuation = expect(
        transport._awaitPendingResponse()
      ).rejects.toThrow("Transport closed");

      await transport.close();

      await request;
      await continuation;
    });

    it("should timeout _awaitPendingResponse when no send() arrives", async () => {
      const transport = new RPCServerTransport({ timeout: 50 });
      await transport.start();

      await expect(transport._awaitPendingResponse()).rejects.toThrow(
        "Request timeout: No response received within 50ms"
      );
    });

    it("should throw when _awaitPendingResponse called before start", async () => {
      const transport = new RPCServerTransport();

      await expect(transport._awaitPendingResponse()).rejects.toThrow(
        "Transport not started"
      );
    });
  });

  describe("Batch Requests", () => {
    it("should handle batch with multiple requests on server", async () => {
      const transport = new RPCServerTransport();
      await transport.start();

      transport.onmessage = async (msg) => {
        const req = msg as { method: string; id?: number };
        if (req.method === "sum") {
          await transport.send({
            jsonrpc: "2.0",
            id: req.id!,
            result: { value: 7 }
          });
        } else if (req.method === "subtract") {
          await transport.send({
            jsonrpc: "2.0",
            id: req.id!,
            result: { value: 19 }
          });
        }
      };

      const batch: JSONRPCMessage[] = [
        { jsonrpc: "2.0", id: 1, method: "sum", params: { a: 1, b: 2 } },
        { jsonrpc: "2.0", id: 2, method: "subtract", params: { a: 42, b: 23 } }
      ];

      const result = await transport.handle(batch);

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
    });

    it("should handle batch with notifications only (returns nothing)", async () => {
      const transport = new RPCServerTransport();
      await transport.start();

      const receivedNotifications: string[] = [];
      transport.onmessage = async (msg) => {
        const notification = msg as { method: string };
        receivedNotifications.push(notification.method);
      };

      const batch: JSONRPCMessage[] = [
        { jsonrpc: "2.0", method: "notify_sum", params: {} },
        { jsonrpc: "2.0", method: "notify_hello", params: {} }
      ];

      const result = await transport.handle(batch);

      expect(result).toBeUndefined();
      expect(receivedNotifications).toEqual(["notify_sum", "notify_hello"]);
    });

    it("should reject empty batch", async () => {
      const transport = new RPCServerTransport();
      await transport.start();

      await expect(transport.handle([])).rejects.toThrow(
        "array must not be empty"
      );
    });
  });

  describe("End-to-End via McpAgent", () => {
    it("should list available tools via RPC", async () => {
      const { connection } = await establishRPCConnection();

      const result = await connection.client.listTools();

      expectValidToolsList({
        jsonrpc: "2.0",
        id: "tools-1",
        result
      });
    });

    it("should invoke concurrent tools via RPC", async () => {
      const { connection } = await establishRPCConnection();

      const [first, second] = await Promise.all([
        connection.client.callTool({
          name: "greet",
          arguments: { name: "Concurrent One" }
        }),
        connection.client.callTool({
          name: "greet",
          arguments: { name: "Concurrent Two" }
        })
      ]);

      expectValidGreetResult(
        {
          jsonrpc: "2.0",
          id: "concurrent-1",
          result: first
        },
        "Concurrent One"
      );
      expectValidGreetResult(
        {
          jsonrpc: "2.0",
          id: "concurrent-2",
          result: second
        },
        "Concurrent Two"
      );
    });

    it("should invoke greet tool via RPC", async () => {
      const { connection } = await establishRPCConnection();

      const result = await connection.client.callTool({
        name: "greet",
        arguments: { name: "Test User" }
      });

      expectValidGreetResult(
        {
          jsonrpc: "2.0",
          id: "greet-1",
          result
        },
        "Test User"
      );
    });

    it("should handle multiple sequential requests", async () => {
      const { connection } = await establishRPCConnection();

      const tools = await connection.client.listTools();
      expect(tools.tools.length).toBeGreaterThan(0);

      const result = await connection.client.callTool({
        name: "greet",
        arguments: { name: "Sequential" }
      });

      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
    });
  });

  describe("Cold Wake Initialization (issue #1282)", () => {
    async function seedStorageForColdWake(
      stub: DurableObjectStub<McpAgent>,
      doName: string
    ) {
      await runInDurableObject(stub, async (instance) => {
        const ctx = (instance as unknown as { ctx: DurableObjectState }).ctx;
        await ctx.storage.put("__ps_name", doName);
      });
    }

    it("should hydrate name and run onStart when handleMcpMessage is the first entry point", async () => {
      const doName = "rpc:cold-wake-init";
      const id = env.MCP_OBJECT.idFromName(doName);
      const stub = env.MCP_OBJECT.get(id);

      // Seed __ps_name directly, bypassing setName/onStart.
      // Simulates a DO that was previously initialized, hibernated,
      // and wakes cold — #_name is unset, only storage has the name.
      await seedStorageForColdWake(stub, doName);

      // Call handleMcpMessage directly via RPC — the native DO RPC
      // entry point that bypasses fetch/alarm/webSocket paths.
      // Before the fix, this threw "Attempting to read .name on
      // TestMcpAgent before it was set" because __unsafe_ensureInitialized
      // was never called.
      const response = await stub.handleMcpMessage(TEST_MESSAGES.initialize);

      expect(response).toBeDefined();
      expect(response).toHaveProperty("result");
    });

    it("should route overlapping handleMcpMessage calls by request id", async () => {
      const doName = `rpc:overlap-${crypto.randomUUID()}`;
      const id = env.MCP_OBJECT.idFromName(doName);
      const stub = env.MCP_OBJECT.get(id) as DurableObjectStub<McpAgent>;

      await seedStorageForColdWake(stub, doName);
      await stub.handleMcpMessage(TEST_MESSAGES.initialize);

      const first = stub.handleMcpMessage({
        jsonrpc: "2.0",
        id: "overlap-1",
        method: "tools/call",
        params: { name: "greet", arguments: { name: "First" } }
      });
      const second = stub.handleMcpMessage({
        jsonrpc: "2.0",
        id: "overlap-2",
        method: "tools/call",
        params: { name: "greet", arguments: { name: "Second" } }
      });

      await expect(first).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: "overlap-1"
      });
      await expect(second).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: "overlap-2"
      });
    });

    it("should handle tool calls after cold wake via handleMcpMessage", async () => {
      const doName = "rpc:cold-wake-tools";
      const id = env.MCP_OBJECT.idFromName(doName);
      const stub = env.MCP_OBJECT.get(id);

      await seedStorageForColdWake(stub, doName);

      // Initialize the MCP server first
      await stub.handleMcpMessage(TEST_MESSAGES.initialize);

      // Now call a tool — verifies the server is fully functional
      const toolResult = await stub.handleMcpMessage(TEST_MESSAGES.greetTool);

      expect(toolResult).toBeDefined();
      expect(toolResult).toHaveProperty("result");
      const content = (
        toolResult as unknown as {
          result: { content: Array<{ text: string }> };
        }
      ).result.content;
      expect(content[0].text).toContain("Test User");
    });
  });
});
