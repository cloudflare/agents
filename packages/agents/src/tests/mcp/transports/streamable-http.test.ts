import { createExecutionContext, env } from "cloudflare:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../../worker";
import {
  TEST_MESSAGES,
  initializeStreamableHTTPServer,
  sendPostRequest,
  expectErrorResponse
} from "../../shared/test-utils";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/**
 * Tests specific to the Streamable HTTP transport protocol
 */
describe("Streamable HTTP Transport", () => {
  const baseUrl = "http://example.com/mcp";

  describe("Session Management", () => {
    it("should initialize server and generate session ID", async () => {
      const ctx = createExecutionContext();

      const response = await sendPostRequest(
        ctx,
        baseUrl,
        TEST_MESSAGES.initialize
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("mcp-session-id")).toBeDefined();
    });

    it("should reject initialization request with session ID", async () => {
      const ctx = createExecutionContext();

      // Send an initialization request with a session ID - this should fail
      const initWithSessionMessage = {
        ...TEST_MESSAGES.initialize,
        id: "init-with-session"
      };

      const response = await sendPostRequest(
        ctx,
        baseUrl,
        initWithSessionMessage,
        "some-session-id"
      );

      expect(response.status).toBe(400);
      const errorData = await response.json();
      expectErrorResponse(
        errorData,
        -32600,
        /Initialization requests must not include a sessionId/
      );
    });

    it("should reject batch with multiple initialization requests", async () => {
      const ctx = createExecutionContext();

      // Send multiple initialization requests in a batch - this should fail
      const batchInitMessages: JSONRPCMessage[] = [
        TEST_MESSAGES.initialize,
        {
          id: "init-2",
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            clientInfo: { name: "test-client-2", version: "1.0" },
            protocolVersion: "2025-03-26"
          }
        }
      ];

      const response = await sendPostRequest(ctx, baseUrl, batchInitMessages);

      expect(response.status).toBe(400);
      const errorData = await response.json();
      expectErrorResponse(
        errorData,
        -32600,
        /Only one initialization request is allowed/
      );
    });

    it("should reject requests without valid session ID", async () => {
      const ctx = createExecutionContext();

      const response = await sendPostRequest(
        ctx,
        baseUrl,
        TEST_MESSAGES.toolsList
      );

      expect(response.status).toBe(400);
      const errorData = await response.json();
      expectErrorResponse(errorData, -32000, /Bad Request/);
    });

    it("should reject invalid session ID", async () => {
      const ctx = createExecutionContext();

      const response = await sendPostRequest(
        ctx,
        baseUrl,
        TEST_MESSAGES.toolsList,
        "invalid-session-id"
      );

      expect(response.status).toBe(404);
      const errorData = await response.json();
      expectErrorResponse(errorData, -32001, /Session not found/);
    });
  });

  describe("HTTP Protocol Features", () => {
    it("should reject POST requests without proper Accept header", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx);

      const request = new Request(baseUrl, {
        body: JSON.stringify(TEST_MESSAGES.toolsList),
        headers: {
          Accept: "application/json", // Missing text/event-stream
          "Content-Type": "application/json",
          "mcp-session-id": sessionId
        },
        method: "POST"
      });
      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(406);
      const errorData = await response.json();
      expectErrorResponse(
        errorData,
        -32000,
        /Client must accept both application\/json and text\/event-stream/
      );
    });

    it("should reject unsupported Content-Type", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx);

      const request = new Request(baseUrl, {
        body: "This is plain text",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "text/plain",
          "mcp-session-id": sessionId
        },
        method: "POST"
      });
      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(415);
      const errorData = await response.json();
      expectErrorResponse(
        errorData,
        -32000,
        /Content-Type must be application\/json/
      );
    });

    it("should handle invalid JSON data", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx);

      const request = new Request(baseUrl, {
        body: "This is not valid JSON",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "mcp-session-id": sessionId
        },
        method: "POST"
      });
      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(400);
      const errorData = await response.json();
      expectErrorResponse(errorData, -32700, /Parse error/);
    });

    it("should return 400 error for invalid JSON-RPC messages", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx);

      const invalidMessage = { id: 1, method: "tools/list", params: {} };
      const response = await sendPostRequest(
        ctx,
        baseUrl,
        invalidMessage as JSONRPCMessage,
        sessionId
      );

      expect(response.status).toBe(400);
      const errorData = await response.json();
      expect(errorData).toMatchObject({
        error: expect.anything(),
        jsonrpc: "2.0"
      });
    });
  });

  describe("Batch Operations", () => {
    it("should reject batch initialization request", async () => {
      const ctx = createExecutionContext();

      const batchInitMessages: JSONRPCMessage[] = [
        TEST_MESSAGES.initialize,
        {
          id: "init-2",
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            clientInfo: { name: "test-client-2", version: "1.0" },
            protocolVersion: "2025-03-26"
          }
        }
      ];

      const response = await sendPostRequest(ctx, baseUrl, batchInitMessages);

      expect(response.status).toBe(400);
      const errorData = await response.json();
      expectErrorResponse(
        errorData,
        -32600,
        /Only one initialization request is allowed/
      );
    });

    it("should handle batch notification messages with 202 response", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx);

      const batchNotifications: JSONRPCMessage[] = [
        { jsonrpc: "2.0", method: "someNotification1", params: {} },
        { jsonrpc: "2.0", method: "someNotification2", params: {} }
      ];
      const response = await sendPostRequest(
        ctx,
        baseUrl,
        batchNotifications,
        sessionId
      );

      expect(response.status).toBe(202);
    });

    it("should handle batch request messages with SSE stream", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx);

      const batchRequests: JSONRPCMessage[] = [
        { id: "req-1", jsonrpc: "2.0", method: "tools/list", params: {} },
        {
          id: "req-2",
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: { name: "BatchUser" }, name: "greet" }
        }
      ];
      const response = await sendPostRequest(
        ctx,
        baseUrl,
        batchRequests,
        sessionId
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");

      const reader = response.body?.getReader();
      const { value: value1 } = await reader!.read();
      const text1 = new TextDecoder().decode(value1);
      const { value: value2 } = await reader!.read();
      const text2 = new TextDecoder().decode(value2);

      const combinedText = text1 + text2;
      expect(combinedText).toContain('"id":"req-1"');
      expect(combinedText).toContain('"tools"');
      expect(combinedText).toContain('"id":"req-2"');
      expect(combinedText).toContain("Hello, BatchUser");
    });
  });

  describe("Concurrent Requests", () => {
    it("should route responses to correct connection", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx);

      const message1: JSONRPCMessage = {
        id: "req-1",
        jsonrpc: "2.0",
        method: "tools/list",
        params: {}
      };

      const message2: JSONRPCMessage = {
        id: "req-2",
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { name: "Connection2" },
          name: "greet"
        }
      };

      const [response1, response2] = await Promise.all([
        sendPostRequest(ctx, baseUrl, message1, sessionId),
        sendPostRequest(ctx, baseUrl, message2, sessionId)
      ]);

      const reader1 = response1.body?.getReader();
      const reader2 = response2.body?.getReader();

      const { value: value1 } = await reader1!.read();
      const text1 = new TextDecoder().decode(value1);
      expect(text1).toContain('"id":"req-1"');
      expect(text1).toContain('"tools"');

      const { value: value2 } = await reader2!.read();
      const text2 = new TextDecoder().decode(value2);
      expect(text2).toContain('"id":"req-2"');
      expect(text2).toContain("Hello, Connection2");
    });
  });
});
