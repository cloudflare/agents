import { describe, expect, it, beforeEach } from "vitest";
import {
  RPCClientTransport,
  RPCServerTransport,
  type MCPStub
} from "../../../mcp/rpc";
import type {
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCNotification
} from "@modelcontextprotocol/sdk/types.js";
import { TEST_MESSAGES } from "../../shared/test-utils";

describe("RPC Transport", () => {
  describe("RPCClientTransport", () => {
    it("should start and close transport", async () => {
      const mockStub: MCPStub = {
        handleMcpMessage: async () => undefined
      };

      const transport = new RPCClientTransport({ stub: mockStub });

      await transport.start();

      let closeCalled = false;
      transport.onclose = () => {
        closeCalled = true;
      };

      await transport.close();
      expect(closeCalled).toBe(true);
    });

    it("should throw error when sending before start", async () => {
      const mockStub: MCPStub = {
        handleMcpMessage: async () => undefined
      };

      const transport = new RPCClientTransport({ stub: mockStub });

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

      const mockStub: MCPStub = {
        handleMcpMessage: async () => mockResponse
      };

      const transport = new RPCClientTransport({ stub: mockStub });
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

      const mockStub: MCPStub = {
        handleMcpMessage: async () => mockResponses
      };

      const transport = new RPCClientTransport({ stub: mockStub });
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

    it("should handle stub returning void", async () => {
      const mockStub: MCPStub = {
        handleMcpMessage: async () => undefined
      };

      const transport = new RPCClientTransport({ stub: mockStub });
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

    it("should call onerror on stub error", async () => {
      const mockError = new Error("Stub error");
      const mockStub: MCPStub = {
        handleMcpMessage: async () => {
          throw mockError;
        }
      };

      const transport = new RPCClientTransport({ stub: mockStub });
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

      await expect(transport.send(message)).rejects.toThrow("Stub error");
      expect(errorReceived).toEqual(mockError);
    });

    it("should use custom function name", async () => {
      let calledFunction: string | undefined;

      const mockStub = {
        handleMcpMessage: async () => undefined,
        customHandle: async () => {
          calledFunction = "customHandle";
          return undefined;
        }
      } as MCPStub & {
        customHandle: (msg: JSONRPCMessage) => Promise<void>;
      };

      const transport = new RPCClientTransport({
        stub: mockStub,
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
      const mockStub: MCPStub = {
        handleMcpMessage: async () => undefined
      };

      const transport = new RPCClientTransport({ stub: mockStub });
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

    it("should support session ID generation after initialization", async () => {
      const transport = new RPCServerTransport({
        sessionIdGenerator: () => "test-session"
      });
      await transport.start();

      // Session ID is undefined until initialization
      expect(transport.sessionId).toBeUndefined();

      transport.onmessage = (msg) => {
        transport.send({
          jsonrpc: "2.0",
          id: (msg as { id: number }).id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            serverInfo: { name: "test", version: "1.0.0" }
          }
        });
      };

      // After initialization, session ID should be set
      await transport.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" }
        }
      });

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

      const stub: MCPStub = {
        handleMcpMessage: async (msg: JSONRPCMessage) => {
          return await serverTransport.handle(msg);
        }
      };

      clientTransport = new RPCClientTransport({ stub });
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

  describe("JSON-RPC 2.0 Validation", () => {
    describe("Request/Notification Validation", () => {
      it("should reject request without jsonrpc field", async () => {
        const mockStub: MCPStub = {
          handleMcpMessage: async () => undefined
        };
        const transport = new RPCClientTransport({ stub: mockStub });
        await transport.start();

        const invalidMessage = {
          id: 1,
          method: "test",
          params: {}
        } as unknown as JSONRPCMessage;

        await expect(transport.send(invalidMessage)).rejects.toThrow(
          'jsonrpc field must be "2.0"'
        );
      });

      it("should reject request with wrong jsonrpc version", async () => {
        const mockStub: MCPStub = {
          handleMcpMessage: async () => undefined
        };
        const transport = new RPCClientTransport({ stub: mockStub });
        await transport.start();

        const invalidMessage = {
          jsonrpc: "1.0",
          id: 1,
          method: "test",
          params: {}
        } as unknown as JSONRPCMessage;

        await expect(transport.send(invalidMessage)).rejects.toThrow(
          'jsonrpc field must be "2.0"'
        );
      });

      it("should reject request with non-string method", async () => {
        const mockStub: MCPStub = {
          handleMcpMessage: async () => undefined
        };
        const transport = new RPCClientTransport({ stub: mockStub });
        await transport.start();

        const invalidMessage = {
          jsonrpc: "2.0",
          id: 1,
          method: 123,
          params: {}
        } as unknown as JSONRPCMessage;

        await expect(transport.send(invalidMessage)).rejects.toThrow(
          "method must be a string"
        );
      });

      it("should reject request with reserved rpc.* method name", async () => {
        const mockStub: MCPStub = {
          handleMcpMessage: async () => undefined
        };
        const transport = new RPCClientTransport({ stub: mockStub });
        await transport.start();

        const invalidMessage: JSONRPCMessage = {
          jsonrpc: "2.0",
          id: 1,
          method: "rpc.reserved",
          params: {}
        };

        await expect(transport.send(invalidMessage)).rejects.toThrow(
          'method names starting with "rpc." are reserved'
        );
      });

      it("should reject request with invalid id type", async () => {
        const mockStub: MCPStub = {
          handleMcpMessage: async () => undefined
        };
        const transport = new RPCClientTransport({ stub: mockStub });
        await transport.start();

        const invalidMessage = {
          jsonrpc: "2.0",
          id: { invalid: true },
          method: "test",
          params: {}
        } as unknown as JSONRPCMessage;

        await expect(transport.send(invalidMessage)).rejects.toThrow(
          "id must be string, number, or null"
        );
      });

      it("should accept request with null id", async () => {
        const mockStub: MCPStub = {
          handleMcpMessage: async () => undefined
        };
        const transport = new RPCClientTransport({ stub: mockStub });
        await transport.start();

        const validMessage = {
          jsonrpc: "2.0",
          id: null,
          method: "test",
          params: {}
        } as unknown as JSONRPCMessage;

        await expect(transport.send(validMessage)).resolves.not.toThrow();
      });

      it("should reject request with non-structured params", async () => {
        const mockStub: MCPStub = {
          handleMcpMessage: async () => undefined
        };
        const transport = new RPCClientTransport({ stub: mockStub });
        await transport.start();

        const invalidMessage = {
          jsonrpc: "2.0",
          id: 1,
          method: "test",
          params: "string params not allowed"
        } as unknown as JSONRPCMessage;

        await expect(transport.send(invalidMessage)).rejects.toThrow(
          "params must be an array or object"
        );
      });

      it("should accept request with array params", async () => {
        const mockStub: MCPStub = {
          handleMcpMessage: async () => undefined
        };
        const transport = new RPCClientTransport({ stub: mockStub });
        await transport.start();

        const validMessage = {
          jsonrpc: "2.0",
          id: 1,
          method: "test",
          params: [1, 2, 3]
        } as unknown as JSONRPCMessage;

        await expect(transport.send(validMessage)).resolves.not.toThrow();
      });

      it("should accept request with object params", async () => {
        const mockStub: MCPStub = {
          handleMcpMessage: async () => undefined
        };
        const transport = new RPCClientTransport({ stub: mockStub });
        await transport.start();

        // Use TEST_MESSAGES.toolsList as a valid example
        await expect(
          transport.send(TEST_MESSAGES.toolsList)
        ).resolves.not.toThrow();
      });

      it("should accept request without params", async () => {
        const mockStub: MCPStub = {
          handleMcpMessage: async () => undefined
        };
        const transport = new RPCClientTransport({ stub: mockStub });
        await transport.start();

        const validMessage: JSONRPCMessage = {
          jsonrpc: "2.0",
          id: 1,
          method: "test"
        };

        await expect(transport.send(validMessage)).resolves.not.toThrow();
      });

      it("should accept notification without id", async () => {
        const mockStub: MCPStub = {
          handleMcpMessage: async () => undefined
        };
        const transport = new RPCClientTransport({ stub: mockStub });
        await transport.start();

        const validMessage: JSONRPCMessage = {
          jsonrpc: "2.0",
          method: "notification",
          params: {}
        };

        await expect(transport.send(validMessage)).resolves.not.toThrow();
      });
    });

    describe("Response Validation", () => {
      it("should reject response without result or error", async () => {
        const invalidResponse = {
          jsonrpc: "2.0",
          id: 1
        } as unknown as JSONRPCMessage;

        const mockStub: MCPStub = {
          handleMcpMessage: async () => invalidResponse
        };
        const transport = new RPCClientTransport({ stub: mockStub });
        await transport.start();

        await expect(transport.send(TEST_MESSAGES.toolsList)).rejects.toThrow(
          "must have either result or error"
        );
      });

      it("should reject response with both result and error", async () => {
        const invalidResponse = {
          jsonrpc: "2.0",
          id: 1,
          result: { data: "test" },
          error: { code: -32600, message: "Invalid" }
        } as unknown as JSONRPCMessage;

        const mockStub: MCPStub = {
          handleMcpMessage: async () => invalidResponse
        };
        const transport = new RPCClientTransport({ stub: mockStub });
        await transport.start();

        await expect(transport.send(TEST_MESSAGES.toolsList)).rejects.toThrow(
          "cannot have both result and error"
        );
      });

      it("should accept response with null id (parse error case)", async () => {
        const validResponse = {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" }
        } as unknown as JSONRPCMessage;

        const mockStub: MCPStub = {
          handleMcpMessage: async () => validResponse
        };
        const transport = new RPCClientTransport({ stub: mockStub });
        await transport.start();

        let received: JSONRPCMessage | undefined;
        transport.onmessage = (msg: JSONRPCMessage) => {
          received = msg;
        };

        await transport.send(TEST_MESSAGES.toolsList);
        expect(received).toEqual(validResponse);
      });
    });

    describe("Error Object Validation", () => {
      it("should reject error with non-number code", async () => {
        const invalidResponse = {
          jsonrpc: "2.0",
          id: 1,
          error: { code: "not a number", message: "Error" }
        } as unknown as JSONRPCMessage;

        const mockStub: MCPStub = {
          handleMcpMessage: async () => invalidResponse
        };
        const transport = new RPCClientTransport({ stub: mockStub });
        await transport.start();

        await expect(transport.send(TEST_MESSAGES.toolsList)).rejects.toThrow(
          "code must be a number"
        );
      });

      it("should reject error with non-integer code", async () => {
        const invalidResponse = {
          jsonrpc: "2.0",
          id: 1,
          error: { code: 123.45, message: "Error" }
        } as unknown as JSONRPCMessage;

        const mockStub: MCPStub = {
          handleMcpMessage: async () => invalidResponse
        };
        const transport = new RPCClientTransport({ stub: mockStub });
        await transport.start();

        await expect(transport.send(TEST_MESSAGES.toolsList)).rejects.toThrow(
          "code must be an integer"
        );
      });

      it("should reject error with non-string message", async () => {
        const invalidResponse = {
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32600, message: 123 }
        } as unknown as JSONRPCMessage;

        const mockStub: MCPStub = {
          handleMcpMessage: async () => invalidResponse
        };
        const transport = new RPCClientTransport({ stub: mockStub });
        await transport.start();

        await expect(transport.send(TEST_MESSAGES.toolsList)).rejects.toThrow(
          "message must be a string"
        );
      });

      it("should accept error with valid structure and optional data", async () => {
        const validResponse: JSONRPCMessage = {
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32600,
            message: "Invalid Request",
            data: { details: "Additional error info" }
          }
        };

        const mockStub: MCPStub = {
          handleMcpMessage: async () => validResponse
        };
        const transport = new RPCClientTransport({ stub: mockStub });
        await transport.start();

        let received: JSONRPCMessage | undefined;
        transport.onmessage = (msg: JSONRPCMessage) => {
          received = msg;
        };

        await transport.send(TEST_MESSAGES.toolsList);
        expect(received).toEqual(validResponse);
      });

      it("should accept standard JSON-RPC error codes", async () => {
        const errorCodes = [
          { code: -32700, message: "Parse error" },
          { code: -32600, message: "Invalid Request" },
          { code: -32601, message: "Method not found" },
          { code: -32602, message: "Invalid params" },
          { code: -32603, message: "Internal error" },
          { code: -32000, message: "Server error" }
        ];

        for (const error of errorCodes) {
          const validResponse: JSONRPCMessage = {
            jsonrpc: "2.0",
            id: 1,
            error
          };

          const mockStub: MCPStub = {
            handleMcpMessage: async () => validResponse
          };
          const transport = new RPCClientTransport({ stub: mockStub });
          await transport.start();

          let received: JSONRPCMessage | undefined;
          transport.onmessage = (msg: JSONRPCMessage) => {
            received = msg;
          };

          await transport.send(TEST_MESSAGES.toolsList);
          expect(received).toEqual(validResponse);
        }
      });
    });

    describe("Server Transport Validation", () => {
      it("should validate incoming requests", async () => {
        const transport = new RPCServerTransport();
        await transport.start();

        const invalidMessage = {
          jsonrpc: "2.0",
          id: 1,
          method: "rpc.internal"
        } as JSONRPCMessage;

        await expect(transport.handle(invalidMessage)).rejects.toThrow(
          'method names starting with "rpc." are reserved'
        );
      });

      it("should validate outgoing responses", async () => {
        const transport = new RPCServerTransport();
        await transport.start();

        const invalidMessage = {
          jsonrpc: "2.0",
          id: 1
        } as unknown as JSONRPCMessage;

        await expect(transport.send(invalidMessage)).rejects.toThrow(
          "must have either result or error"
        );
      });

      it("should validate response ID matches request ID (JSON-RPC 2.0 spec section 5)", async () => {
        const transport = new RPCServerTransport();
        await transport.start();

        // Set up message handler first
        transport.onmessage = async () => {
          // Try to send response with mismatched id
          await expect(
            transport.send({
              jsonrpc: "2.0",
              id: 2, // Wrong ID! Should be 1
              result: { data: "response" }
            })
          ).rejects.toThrow(
            "Response ID 2 does not match request ID 1 (JSON-RPC 2.0 spec section 5)"
          );

          // Send correct response to complete the test
          await transport.send({
            jsonrpc: "2.0",
            id: 1,
            result: { data: "response" }
          });
        };

        // Start handling a request with id: 1
        await transport.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "test",
          params: {}
        });
      });

      it("should allow notifications alongside responses", async () => {
        const transport = new RPCServerTransport();
        await transport.start();

        // Set up message handler first
        transport.onmessage = async () => {
          // Send a notification (no id) - should be allowed
          await transport.send({
            jsonrpc: "2.0",
            method: "progress",
            params: { percent: 50 }
          });

          // Send the response with matching id
          await transport.send({
            jsonrpc: "2.0",
            id: 1,
            result: { data: "response" }
          });
        };

        // Start handling a request
        const result = await transport.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "test",
          params: {}
        });

        // Should receive both messages
        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(2);
        expect(result).toEqual([
          { jsonrpc: "2.0", method: "progress", params: { percent: 50 } },
          { jsonrpc: "2.0", id: 1, result: { data: "response" } }
        ]);
      });
    });
  });

  describe("Batch Requests (JSON-RPC 2.0 spec section 6)", () => {
    describe("Client Transport Batch Support", () => {
      it("should send batch requests", async () => {
        const batchMessages: JSONRPCMessage[] = [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "sum",
            params: [1, 2, 4] as unknown as Record<string, unknown>
          },
          {
            jsonrpc: "2.0",
            method: "notify_hello",
            params: [7] as unknown as Record<string, unknown>
          },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "subtract",
            params: [42, 23] as unknown as Record<string, unknown>
          }
        ];

        const mockResponses: JSONRPCMessage[] = [
          {
            jsonrpc: "2.0",
            id: 1,
            result: 7 as unknown as Record<string, unknown>
          },
          {
            jsonrpc: "2.0",
            id: 2,
            result: 19 as unknown as Record<string, unknown>
          }
        ];

        const mockStub: MCPStub = {
          handleMcpMessage: async () => mockResponses
        };

        const transport = new RPCClientTransport({ stub: mockStub });
        await transport.start();

        const receivedMessages: JSONRPCMessage[] = [];
        transport.onmessage = (msg) => {
          receivedMessages.push(msg);
        };

        await transport.send(batchMessages);

        expect(receivedMessages).toEqual(mockResponses);
      });

      it("should reject empty batch", async () => {
        const mockStub: MCPStub = {
          handleMcpMessage: async () => undefined
        };
        const transport = new RPCClientTransport({ stub: mockStub });
        await transport.start();

        await expect(transport.send([])).rejects.toThrow(
          "array must not be empty"
        );
      });

      it("should reject batch with invalid message", async () => {
        const mockStub: MCPStub = {
          handleMcpMessage: async () => undefined
        };
        const transport = new RPCClientTransport({ stub: mockStub });
        await transport.start();

        const invalidBatch = [
          { jsonrpc: "2.0", id: 1, method: "test", params: {} },
          { invalid: "message" }
        ] as unknown as JSONRPCMessage[];

        await expect(transport.send(invalidBatch)).rejects.toThrow(
          "message at index 1 is invalid"
        );
      });
    });

    describe("Server Transport Batch Support", () => {
      it("should handle batch with multiple requests", async () => {
        const transport = new RPCServerTransport();
        await transport.start();

        transport.onmessage = async (msg) => {
          const req = msg as { method: string; id?: number };
          if (req.method === "sum") {
            await transport.send({
              jsonrpc: "2.0",
              id: req.id!,
              result: 7 as unknown as Record<string, unknown>
            });
          } else if (req.method === "subtract") {
            await transport.send({
              jsonrpc: "2.0",
              id: req.id!,
              result: 19 as unknown as Record<string, unknown>
            });
          }
        };

        const batch: JSONRPCMessage[] = [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "sum",
            params: [1, 2, 4] as unknown as Record<string, unknown>
          },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "subtract",
            params: [42, 23] as unknown as Record<string, unknown>
          }
        ];

        const result = await transport.handle(batch);

        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(2);
        expect(result).toEqual([
          {
            jsonrpc: "2.0",
            id: 1,
            result: 7 as unknown as Record<string, unknown>
          },
          {
            jsonrpc: "2.0",
            id: 2,
            result: 19 as unknown as Record<string, unknown>
          }
        ]);
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
          {
            jsonrpc: "2.0",
            method: "notify_sum",
            params: [1, 2, 4] as unknown as Record<string, unknown>
          },
          {
            jsonrpc: "2.0",
            method: "notify_hello",
            params: [7] as unknown as Record<string, unknown>
          }
        ];

        const result = await transport.handle(batch);

        // Spec: "should return nothing at all" when all notifications
        expect(result).toBeUndefined();
        expect(receivedNotifications).toEqual(["notify_sum", "notify_hello"]);
      });

      it("should handle batch with mixed requests and notifications", async () => {
        const transport = new RPCServerTransport();
        await transport.start();

        const receivedNotifications: string[] = [];
        transport.onmessage = async (msg) => {
          const req = msg as { method: string; id?: number };
          if (!("id" in msg)) {
            receivedNotifications.push(req.method);
          } else if (req.method === "sum") {
            await transport.send({
              jsonrpc: "2.0",
              id: req.id!,
              result: 7 as unknown as Record<string, unknown>
            });
          }
        };

        const batch: JSONRPCMessage[] = [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "sum",
            params: [1, 2, 4] as unknown as Record<string, unknown>
          },
          {
            jsonrpc: "2.0",
            method: "notify_hello",
            params: [7] as unknown as Record<string, unknown>
          }
        ];

        const result = await transport.handle(batch);

        // Should have response for request, but not for notification
        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(1);
        expect(result).toEqual([
          {
            jsonrpc: "2.0",
            id: 1,
            result: 7 as unknown as Record<string, unknown>
          }
        ]);
        expect(receivedNotifications).toEqual(["notify_hello"]);
      });

      it("should reject empty batch", async () => {
        const transport = new RPCServerTransport();
        await transport.start();

        await expect(transport.handle([])).rejects.toThrow(
          "array must not be empty"
        );
      });

      it("should reject batch with invalid message", async () => {
        const transport = new RPCServerTransport();
        await transport.start();

        const invalidBatch = [
          { jsonrpc: "2.0", id: 1, method: "test", params: {} },
          { invalid: "message" }
        ] as unknown as JSONRPCMessage[];

        await expect(transport.handle(invalidBatch)).rejects.toThrow(
          "message at index 1 is invalid"
        );
      });
    });

    describe("End-to-End Batch Processing", () => {
      it("should handle complete batch request-response cycle", async () => {
        const serverTransport = new RPCServerTransport();
        await serverTransport.start();

        serverTransport.onmessage = async (msg) => {
          const req = msg as { method: string; id?: number; params?: number[] };
          if (req.method === "sum" && req.id) {
            const sum = (req.params || []).reduce((a, b) => a + b, 0);
            await serverTransport.send({
              jsonrpc: "2.0",
              id: req.id,
              result: sum as unknown as Record<string, unknown>
            });
          } else if (req.method === "subtract" && req.id) {
            const [a, b] = req.params || [0, 0];
            await serverTransport.send({
              jsonrpc: "2.0",
              id: req.id,
              result: (a - b) as unknown as Record<string, unknown>
            });
          }
        };

        const stub: MCPStub = {
          handleMcpMessage: async (msg: JSONRPCMessage | JSONRPCMessage[]) => {
            return await serverTransport.handle(msg);
          }
        };

        const clientTransport = new RPCClientTransport({ stub });
        await clientTransport.start();

        const receivedMessages: JSONRPCMessage[] = [];
        clientTransport.onmessage = (msg) => {
          receivedMessages.push(msg);
        };

        const batch: JSONRPCMessage[] = [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "sum",
            params: [1, 2, 4] as unknown as Record<string, unknown>
          },
          {
            jsonrpc: "2.0",
            method: "notify_hello",
            params: [7] as unknown as Record<string, unknown>
          },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "subtract",
            params: [42, 23] as unknown as Record<string, unknown>
          }
        ];

        await clientTransport.send(batch);

        expect(receivedMessages).toHaveLength(2);
        expect(receivedMessages).toEqual([
          {
            jsonrpc: "2.0",
            id: 1,
            result: 7 as unknown as Record<string, unknown>
          },
          {
            jsonrpc: "2.0",
            id: 2,
            result: 19 as unknown as Record<string, unknown>
          }
        ]);
      });
    });
  });

  describe("Session Management", () => {
    describe("Stateless Mode (no session ID generator)", () => {
      it("should work without session management when no sessionIdGenerator is provided", async () => {
        const transport = new RPCServerTransport();
        await transport.start();

        let receivedMessage: JSONRPCMessage | undefined;
        transport.onmessage = (msg) => {
          receivedMessage = msg;
          transport.send({
            jsonrpc: "2.0",
            id: (msg as { id: number }).id,
            result: { success: true }
          });
        };

        const response = await transport.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "test",
          params: {}
        });

        expect(receivedMessage).toBeDefined();
        expect(response).toEqual({
          jsonrpc: "2.0",
          id: 1,
          result: { success: true }
        });
        expect(transport.sessionId).toBeUndefined();
      });

      it("should allow any request without initialization in stateless mode", async () => {
        const transport = new RPCServerTransport();
        await transport.start();

        let receivedCount = 0;
        transport.onmessage = (msg) => {
          receivedCount++;
          transport.send({
            jsonrpc: "2.0",
            id: (msg as { id: number }).id,
            result: { count: receivedCount }
          });
        };

        // First request should work without initialize
        const response1 = await transport.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {}
        });

        expect(response1).toEqual({
          jsonrpc: "2.0",
          id: 1,
          result: { count: 1 }
        });

        // Second request should also work
        const response2 = await transport.handle({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {}
        });

        expect(response2).toEqual({
          jsonrpc: "2.0",
          id: 2,
          result: { count: 2 }
        });
      });
    });

    describe("Stateful Mode (with session ID generator)", () => {
      it("should generate session ID during initialization", async () => {
        let initializedSessionId: string | undefined;
        const sessionIdGenerator = () => "test-session-123";

        const transport = new RPCServerTransport({
          sessionIdGenerator,
          onsessioninitialized: (sessionId) => {
            initializedSessionId = sessionId;
          }
        });
        await transport.start();

        transport.onmessage = (msg) => {
          transport.send({
            jsonrpc: "2.0",
            id: (msg as { id: number }).id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "test", version: "1.0.0" }
            }
          });
        };

        const response = await transport.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" }
          }
        });

        expect(response).toBeDefined();
        expect(transport.sessionId).toBe("test-session-123");
        expect(initializedSessionId).toBe("test-session-123");
      });

      it("should reject non-initialization requests before session is initialized", async () => {
        const sessionIdGenerator = () => "test-session-456";
        const transport = new RPCServerTransport({
          sessionIdGenerator
        });
        await transport.start();

        transport.onmessage = (msg) => {
          transport.send({
            jsonrpc: "2.0",
            id: (msg as { id: number }).id,
            result: { success: true }
          });
        };

        // Try to send a non-initialization request before initialize
        await expect(
          transport.handle({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {}
          })
        ).rejects.toThrow(
          "Session not initialized. An initialize request must be sent first."
        );

        expect(transport.sessionId).toBeUndefined();
      });

      it("should reject duplicate initialization requests", async () => {
        const sessionIdGenerator = () => "test-session-789";
        const transport = new RPCServerTransport({
          sessionIdGenerator
        });
        await transport.start();

        transport.onmessage = (msg) => {
          transport.send({
            jsonrpc: "2.0",
            id: (msg as { id: number }).id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "test", version: "1.0.0" }
            }
          });
        };

        // First initialization should succeed
        await transport.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" }
          }
        });

        expect(transport.sessionId).toBe("test-session-789");

        // Second initialization should fail
        await expect(
          transport.handle({
            jsonrpc: "2.0",
            id: 2,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "test-client", version: "1.0.0" }
            }
          })
        ).rejects.toThrow("Session already initialized");
      });

      it("should allow requests after successful initialization", async () => {
        const sessionIdGenerator = () => "test-session-abc";
        const transport = new RPCServerTransport({
          sessionIdGenerator
        });
        await transport.start();

        let requestCount = 0;
        transport.onmessage = (msg) => {
          requestCount++;
          if ((msg as { method: string }).method === "initialize") {
            transport.send({
              jsonrpc: "2.0",
              id: (msg as { id: number }).id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                serverInfo: { name: "test", version: "1.0.0" }
              }
            });
          } else {
            transport.send({
              jsonrpc: "2.0",
              id: (msg as { id: number }).id,
              result: { requestCount }
            });
          }
        };

        // Initialize first
        await transport.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" }
          }
        });

        // Now other requests should work
        const response1 = await transport.handle({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {}
        });

        expect(response1).toEqual({
          jsonrpc: "2.0",
          id: 2,
          result: { requestCount: 2 }
        });

        const response2 = await transport.handle({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {}
        });

        expect(response2).toEqual({
          jsonrpc: "2.0",
          id: 3,
          result: { requestCount: 3 }
        });
      });

      it("should call onsessionclosed when terminateSession is called", async () => {
        let closedSessionId: string | undefined;
        const sessionIdGenerator = () => "test-session-xyz";

        const transport = new RPCServerTransport({
          sessionIdGenerator,
          onsessionclosed: (sessionId) => {
            closedSessionId = sessionId;
          }
        });
        await transport.start();

        transport.onmessage = (msg) => {
          transport.send({
            jsonrpc: "2.0",
            id: (msg as { id: number }).id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "test", version: "1.0.0" }
            }
          });
        };

        // Initialize session
        await transport.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" }
          }
        });

        expect(transport.sessionId).toBe("test-session-xyz");

        // Terminate session
        await transport.terminateSession();

        expect(closedSessionId).toBe("test-session-xyz");
        expect(transport.sessionId).toBeUndefined();
      });

      it("should call onsessionclosed when transport is closed", async () => {
        let closedSessionId: string | undefined;
        const sessionIdGenerator = () => "test-session-close";

        const transport = new RPCServerTransport({
          sessionIdGenerator,
          onsessionclosed: (sessionId) => {
            closedSessionId = sessionId;
          }
        });
        await transport.start();

        transport.onmessage = (msg) => {
          transport.send({
            jsonrpc: "2.0",
            id: (msg as { id: number }).id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "test", version: "1.0.0" }
            }
          });
        };

        // Initialize session
        await transport.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" }
          }
        });

        expect(transport.sessionId).toBe("test-session-close");

        // Close transport
        await transport.close();

        expect(closedSessionId).toBe("test-session-close");
        expect(transport.sessionId).toBeUndefined();
      });

      it("should support async session lifecycle hooks", async () => {
        const hookCalls: string[] = [];
        const sessionIdGenerator = () => "test-session-async";

        const transport = new RPCServerTransport({
          sessionIdGenerator,
          onsessioninitialized: async (sessionId) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            hookCalls.push(`initialized:${sessionId}`);
          },
          onsessionclosed: async (sessionId) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            hookCalls.push(`closed:${sessionId}`);
          }
        });
        await transport.start();

        transport.onmessage = (msg) => {
          transport.send({
            jsonrpc: "2.0",
            id: (msg as { id: number }).id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "test", version: "1.0.0" }
            }
          });
        };

        // Initialize session
        await transport.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" }
          }
        });

        expect(hookCalls).toContain("initialized:test-session-async");

        // Close transport
        await transport.close();

        expect(hookCalls).toContain("closed:test-session-async");
        expect(hookCalls).toHaveLength(2);
      });
    });
  });
});
