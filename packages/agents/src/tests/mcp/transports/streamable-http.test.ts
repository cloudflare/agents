import { createExecutionContext, env } from "cloudflare:test";
import type {
  CallToolResult,
  JSONRPCMessage,
  ListToolsResult,
  JSONRPCNotification,
  JSONRPCResponse
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../../worker";
import {
  TEST_MESSAGES,
  initializeStreamableHTTPServer,
  sendPostRequest,
  expectErrorResponse,
  readSSEEventWithTimeout,
  openStandaloneSSE,
  readSSEEvent,
  parseSSEData,
  expectValidToolsList
} from "../../shared/test-utils";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// small helper to read one full SSE frame from a reader
async function readOneFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<string> {
  const { value } = await reader.read();
  return new TextDecoder().decode(value!);
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

    it("should accept JSON payloads containing Unicode characters", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx);

      const unicodeName = "José’s Café";
      const unicodeRequest: JSONRPCMessage[] = [
        {
          id: "unicode-1",
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "greet",
            arguments: {
              name: unicodeName
            }
          }
        }
      ];

      const response = await sendPostRequest(
        ctx,
        baseUrl,
        unicodeRequest,
        sessionId
      );

      expect(response.status).toBe(200);

      const sseText = await readSSEEvent(response);
      const parsed = parseSSEData(sseText) as JSONRPCResponse;
      expect(parsed.id).toBe("unicode-1");

      const result = parsed.result as CallToolResult;
      expect(result.content).toBeDefined();
      expect(
        result.content?.[0]?.type === "text" &&
          result.content?.[0]?.text === `Hello, ${unicodeName}!`
      ).toBe(true);
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

  describe("Streamable HTTP Standalone SSE (GET)", () => {
    const baseUrl = "http://example.com/mcp";

    it("should open a standalone SSE stream via GET after initialization", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx);

      // Open the standalone stream
      const reader = await openStandaloneSSE(ctx, sessionId, baseUrl);
      expect(reader).toBeDefined();

      // Control frame is internal and not forwarded, no events should be sent.
      const maybe = await readSSEEventWithTimeout(reader, 50);
      expect(maybe).toBeNull();
    });

    it("should continue routing POST responses to their own SSE streams even when standalone SSE is open", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx);

      // Open the standalone stream
      const standaloneReader = await openStandaloneSSE(ctx, sessionId, baseUrl);

      // Send a POST request and check the response comes back on THIS response's SSE,
      // not the standalone stream
      const response = await sendPostRequest(
        ctx,
        baseUrl,
        TEST_MESSAGES.toolsList,
        sessionId
      );
      expect(response.status).toBe(200);

      const sseText = await readSSEEvent(response);
      const result = parseSSEData(sseText);
      expectValidToolsList(result);

      // Ensure the standalone stream did NOT get anything
      const maybe = await readSSEEventWithTimeout(standaloneReader, 50);
      expect(maybe).toBeNull();
    });

    it("should deliver logging/message on the standalone SSE stream", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx);

      // Open the standalone stream
      const standaloneReader = await openStandaloneSSE(ctx, sessionId, baseUrl);

      // Send tools/call message that emits a logging notification
      const emitLogMsg = {
        id: "emit-log-1",
        jsonrpc: "2.0" as const,
        method: "tools/call",
        params: {
          name: "emitLog",
          arguments: { level: "info", message: "hello-standalone" }
        }
      };

      const postRes = await sendPostRequest(
        ctx,
        baseUrl,
        emitLogMsg,
        sessionId
      );
      expect(postRes.status).toBe(200);

      // Read the POST SSE response for the tool return value
      const postFrame = await readSSEEvent(postRes);
      const postJson = parseSSEData(postFrame) as JSONRPCResponse;
      expect(postJson.id).toBe("emit-log-1");
      const result = postJson.result as CallToolResult;
      expect(
        result.content?.[0]?.type === "text" &&
          result.content?.[0]?.text === "logged:info"
      ).toBe(true);

      // Read the standalone SSE for the logging notification
      const pushFrame = await readOneFrame(standaloneReader);
      const pushJson = parseSSEData(pushFrame) as JSONRPCNotification;

      expect(pushJson).toMatchObject({
        jsonrpc: "2.0",
        method: "notifications/message",
        params: expect.objectContaining({
          level: "info",
          data: "hello-standalone"
        })
      });

      // Standalone stream remains open
      const silent = await readSSEEventWithTimeout(standaloneReader, 50);
      expect(silent).toBeNull();
    });

    it("should emit tools list_changed on install/uninstall and reflect in tools/list", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx);

      // Standalone push stream
      const standaloneReader = await openStandaloneSSE(ctx, sessionId, baseUrl);

      // Install the temporary tool so the server notifies of tools/list_changed on standalone stream
      const installMsg = {
        id: "install-1",
        jsonrpc: "2.0" as const,
        method: "tools/call",
        params: { name: "installTempTool", arguments: {} }
      };
      const installRes = await sendPostRequest(
        ctx,
        baseUrl,
        installMsg,
        sessionId
      );
      expect(installRes.status).toBe(200);
      const installFrame = await readSSEEvent(installRes);
      const installJson = parseSSEData(installFrame) as JSONRPCResponse;
      expect(installJson.id).toBe("install-1");
      let result = installJson.result as CallToolResult;
      expect(
        result?.content?.[0]?.type === "text" &&
          result?.content?.[0]?.text === "temp tool installed"
      ).toBe(true);

      // Expect a tools/list_changed notification on the standalone stream
      let listChanged = await readOneFrame(standaloneReader);
      let listChangedJson = parseSSEData(listChanged) as JSONRPCNotification;
      expect(listChangedJson.method).toBe("notifications/tools/list_changed");

      // Verify the tool we just installed appears in tools/list
      let listReq = {
        id: "tools-after-install",
        jsonrpc: "2.0" as const,
        method: "tools/list",
        params: {}
      };
      let listRes = await sendPostRequest(ctx, baseUrl, listReq, sessionId);
      expect(listRes.status).toBe(200);
      let listFrame = await readSSEEvent(listRes);
      let listJson = parseSSEData(listFrame) as JSONRPCResponse;
      let tools = (listJson.result?.tools ?? []) as ListToolsResult["tools"];
      expect(tools.some((t) => t.name === "temp-echo")).toBe(true);

      // Check that we can call the tool too
      const runTempToolMsg = {
        id: "run-temp-1",
        jsonrpc: "2.0" as const,
        method: "tools/call",
        params: { name: "temp-echo", arguments: { what: "test" } }
      };
      const runTempRes = await sendPostRequest(
        ctx,
        baseUrl,
        runTempToolMsg,
        sessionId
      );
      expect(installRes.status).toBe(200);
      const runTempFrame = await readSSEEvent(runTempRes);
      const runTempJson = parseSSEData(runTempFrame) as JSONRPCResponse;
      expect(runTempJson.id).toBe("run-temp-1");
      result = runTempJson.result as CallToolResult;
      expect(
        result?.content?.[0]?.type === "text" &&
          result?.content?.[0]?.text === "echo:test"
      ).toBe(true);

      // Uninstall temp tool so we get another list_changed on standalone stream
      const uninstallMsg = {
        id: "uninstall-1",
        jsonrpc: "2.0" as const,
        method: "tools/call",
        params: { name: "uninstallTempTool", arguments: {} }
      };
      const uninstallRes = await sendPostRequest(
        ctx,
        baseUrl,
        uninstallMsg,
        sessionId
      );
      expect(uninstallRes.status).toBe(200);
      const uninstallFrame = await readSSEEvent(uninstallRes);
      const uninstallJson = parseSSEData(uninstallFrame) as JSONRPCResponse;
      expect(uninstallJson.id).toBe("uninstall-1");

      listChanged = await readOneFrame(standaloneReader);
      listChangedJson = parseSSEData(listChanged) as JSONRPCNotification;
      expect(listChangedJson.method).toBe("notifications/tools/list_changed");

      // Check temp tool is gone
      listReq = {
        id: "tools-after-uninstall",
        jsonrpc: "2.0" as const,
        method: "tools/list",
        params: {}
      };
      listRes = await sendPostRequest(ctx, baseUrl, listReq, sessionId);
      expect(listRes.status).toBe(200);
      listFrame = await readSSEEvent(listRes);
      listJson = parseSSEData(listFrame) as JSONRPCResponse;
      tools = (listJson.result?.tools ?? []) as ListToolsResult["tools"];
      expect(tools.some((t) => t.name === "temp-echo")).toBe(false);
    });
  });

  describe("Header and Auth Handling", () => {
    it("should pass custom headers to transport via requestInfo", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx);

      // Send request with custom headers using the echoRequestInfo tool
      const echoMessage: JSONRPCMessage = {
        id: "echo-headers-1",
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "echoRequestInfo",
          arguments: {}
        }
      };

      const request = new Request(baseUrl, {
        body: JSON.stringify(echoMessage),
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "mcp-session-id": sessionId,
          "x-user-id": "test-user-123",
          "x-request-id": "req-456",
          "x-custom-header": "custom-value"
        },
        method: "POST"
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);

      // Parse the SSE response
      const sseText = await readSSEEvent(response);
      const parsed = parseSSEData(sseText) as JSONRPCResponse;
      expect(parsed.id).toBe("echo-headers-1");

      // Extract the echoed request info
      const result = parsed.result as CallToolResult;
      const firstContent = result.content?.[0];
      const contentText =
        firstContent?.type === "text" ? firstContent.text : undefined;
      const echoedData = JSON.parse(
        typeof contentText === "string" ? contentText : "{}"
      );

      // Verify custom headers were passed through
      expect(echoedData.hasRequestInfo).toBe(true);
      expect(echoedData.headers["x-user-id"]).toBe("test-user-123");
      expect(echoedData.headers["x-request-id"]).toBe("req-456");
      expect(echoedData.headers["x-custom-header"]).toBe("custom-value");

      // Verify that certain internal headers that the transport adds are NOT exposed
      // The transport adds cf-mcp-method and cf-mcp-message internally but should filter them
      expect(echoedData.headers["cf-mcp-method"]).toBeUndefined();
      expect(echoedData.headers["cf-mcp-message"]).toBeUndefined();
      expect(echoedData.headers.upgrade).toBeUndefined();

      // Verify standard headers are also present
      expect(echoedData.headers.accept).toContain("text/event-stream");
      expect(echoedData.headers["content-type"]).toBe("application/json");

      // Verify sessionId is passed through extra data
      expect(echoedData.sessionId).toBeDefined();
      expect(echoedData.sessionId).toBe(sessionId);
    });
  });
});
