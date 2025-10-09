import { describe, expect, it, beforeEach } from "vitest";
import {
  RPCClientTransport,
  RPCServerTransport,
  type RPCBinding
} from "../../../mcp/rpc-transport";
import type {
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCNotification
} from "@modelcontextprotocol/sdk/types.js";

describe("RPC Transport", () => {
  describe("RPCClientTransport", () => {
    it("should start and close transport", async () => {
      const mockBinding: RPCBinding = {
        handle: async () => undefined
      };

      const transport = new RPCClientTransport({ binding: mockBinding });

      await transport.start();
      expect(transport["_started"]).toBe(true);

      await transport.close();
      expect(transport["_started"]).toBe(false);
    });

    it("should throw error when sending before start", async () => {
      const mockBinding: RPCBinding = {
        handle: async () => undefined
      };

      const transport = new RPCClientTransport({ binding: mockBinding });

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

    it("should send message and receive single response", async () => {
      const mockResponse: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: 1,
        result: { success: true }
      };

      const mockBinding: RPCBinding = {
        handle: async () => mockResponse
      };

      const transport = new RPCClientTransport({ binding: mockBinding });
      await transport.start();

      let receivedMessage: JSONRPCMessage | undefined;
      transport.onmessage = (msg) => {
        receivedMessage = msg;
      };

      const message: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: 1,
        method: "test",
        params: {}
      };

      await transport.send(message);

      expect(receivedMessage).toEqual(mockResponse);
    });

    it("should send message and receive multiple responses", async () => {
      const mockResponses: JSONRPCMessage[] = [
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

      const mockBinding: RPCBinding = {
        handle: async () => mockResponses
      };

      const transport = new RPCClientTransport({ binding: mockBinding });
      await transport.start();

      const receivedMessages: JSONRPCMessage[] = [];
      transport.onmessage = (msg) => {
        receivedMessages.push(msg);
      };

      const message: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: 1,
        method: "test",
        params: {}
      };

      await transport.send(message);

      expect(receivedMessages).toEqual(mockResponses);
    });

    it("should handle binding returning void", async () => {
      const mockBinding: RPCBinding = {
        handle: async () => undefined
      };

      const transport = new RPCClientTransport({ binding: mockBinding });
      await transport.start();

      let receivedMessage: JSONRPCMessage | undefined;
      transport.onmessage = (msg) => {
        receivedMessage = msg;
      };

      const message: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "notification",
        params: {}
      };

      await transport.send(message);

      expect(receivedMessage).toBeUndefined();
    });

    it("should call onerror on binding error", async () => {
      const mockError = new Error("Binding error");
      const mockBinding: RPCBinding = {
        handle: async () => {
          throw mockError;
        }
      };

      const transport = new RPCClientTransport({ binding: mockBinding });
      await transport.start();

      let errorReceived: Error | undefined;
      transport.onerror = (err) => {
        errorReceived = err;
      };

      const message: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: 1,
        method: "test",
        params: {}
      };

      await expect(transport.send(message)).rejects.toThrow("Binding error");
      expect(errorReceived).toEqual(mockError);
    });

    it("should use custom function name", async () => {
      let calledFunction: string | undefined;

      const mockBinding = {
        handle: async () => undefined,
        customHandle: async () => {
          calledFunction = "customHandle";
          return undefined;
        }
      } as RPCBinding & {
        customHandle: (msg: JSONRPCMessage) => Promise<void>;
      };

      const transport = new RPCClientTransport({
        binding: mockBinding,
        functionName: "customHandle"
      });
      await transport.start();

      const message: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "test",
        params: {}
      };

      await transport.send(message);

      expect(calledFunction).toBe("customHandle");
    });

    it("should call onclose when closing", async () => {
      const mockBinding: RPCBinding = {
        handle: async () => undefined
      };

      const transport = new RPCClientTransport({ binding: mockBinding });
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
      expect(transport["_started"]).toBe(true);

      await transport.close();
      expect(transport["_started"]).toBe(false);
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

    it("should handle request with no response", async () => {
      const transport = new RPCServerTransport();
      await transport.start();

      let messageReceived = false;
      transport.onmessage = () => {
        messageReceived = true;
      };

      const handlePromise = transport.handle({
        jsonrpc: "2.0",
        method: "notification",
        params: {}
      });

      setTimeout(async () => {
        await transport.send({
          jsonrpc: "2.0",
          id: 1,
          result: {}
        });
      }, 50);

      const result = await handlePromise;
      expect(messageReceived).toBe(true);
      expect(result).toBeDefined();
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

    it("should support session ID", async () => {
      const transport = new RPCServerTransport({ sessionId: "test-session" });

      expect(transport.sessionId).toBe("test-session");
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
  });

  describe("Client-Server Integration", () => {
    let clientTransport: RPCClientTransport;
    let serverTransport: RPCServerTransport;

    beforeEach(async () => {
      serverTransport = new RPCServerTransport();
      await serverTransport.start();

      const binding: RPCBinding = {
        handle: async (msg: JSONRPCMessage) => {
          return await serverTransport.handle(msg);
        }
      };

      clientTransport = new RPCClientTransport({ binding });
      await clientTransport.start();
    });

    it("should handle complete request-response cycle", async () => {
      serverTransport.onmessage = async () => {
        await serverTransport.send({
          jsonrpc: "2.0",
          id: 1,
          result: { data: "response" }
        });
      };

      const receivedMessages: JSONRPCMessage[] = [];
      clientTransport.onmessage = (msg) => {
        receivedMessages.push(msg);
      };

      await clientTransport.send({
        jsonrpc: "2.0",
        id: 1,
        method: "test",
        params: { data: "request" }
      });

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0]).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: { data: "response" }
      });
    });

    it("should handle notification (no response expected)", async () => {
      let serverReceivedNotification = false;
      serverTransport.onmessage = async (msg) => {
        const notification = msg as JSONRPCNotification;
        if (notification.method === "notification") {
          serverReceivedNotification = true;
        }
        await serverTransport.send({
          jsonrpc: "2.0",
          method: "ack",
          params: {}
        });
      };

      await clientTransport.send({
        jsonrpc: "2.0",
        method: "notification",
        params: { data: "notify" }
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(serverReceivedNotification).toBe(true);
    });

    it("should handle multiple messages", async () => {
      const responses = [
        { jsonrpc: "2.0" as const, id: 1, result: { data: "first" } },
        { jsonrpc: "2.0" as const, id: 2, result: { data: "second" } }
      ];

      serverTransport.onmessage = async (msg) => {
        const req = msg as JSONRPCRequest;
        if (req.id === 1) {
          await serverTransport.send(responses[0]);
        } else if (req.id === 2) {
          await serverTransport.send(responses[1]);
        }
      };

      const receivedMessages: JSONRPCMessage[] = [];
      clientTransport.onmessage = (msg) => {
        receivedMessages.push(msg);
      };

      await clientTransport.send({
        jsonrpc: "2.0",
        id: 1,
        method: "test1",
        params: {}
      });

      await clientTransport.send({
        jsonrpc: "2.0",
        id: 2,
        method: "test2",
        params: {}
      });

      expect(receivedMessages).toHaveLength(2);
      expect(receivedMessages[0]).toMatchObject(responses[0]);
      expect(receivedMessages[1]).toMatchObject(responses[1]);
    });
  });
});
