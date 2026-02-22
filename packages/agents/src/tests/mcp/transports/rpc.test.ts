import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
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
import type { Env } from "../../worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

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

    it("should reject invalid JSON-RPC messages", async () => {
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

      await expect(transport.send(invalidMessage)).rejects.toThrow();
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

    it("should handle request and return multiple responses", async () => {
      const transport = new RPCServerTransport();
      await transport.start();

      const expectedResponses: JSONRPCMessage[] = [
        {
          jsonrpc: "2.0",
          id: 1,
          result: { success: true }
        },
        {
          jsonrpc: "2.0",
          method: "notification",
          params: {}
        }
      ];

      transport.onmessage = (msg) => {
        const req = msg as JSONRPCRequest;
        expect(req.id).toBe(1);
      };

      const handlePromise = transport.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "test",
        params: {}
      });

      for (const response of expectedResponses) {
        await transport.send(response);
      }

      const result = await handlePromise;
      expect(result).toEqual(expectedResponses);
    });

    it("should handle concurrent sends within the same request", async () => {
      const transport = new RPCServerTransport();
      await transport.start();

      const expectedResponses: JSONRPCMessage[] = [
        { jsonrpc: "2.0", id: 1, result: { first: true } },
        { jsonrpc: "2.0", id: 1, result: { second: true } }
      ];

      transport.onmessage = () => {
        transport.send(expectedResponses[0]);
        transport.send(expectedResponses[1]);
      };

      const result = await transport.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "test",
        params: {}
      });

      expect(result).toEqual(expectedResponses);
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
});
