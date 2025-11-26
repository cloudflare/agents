import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  CallToolResult,
  JSONRPCResponse
} from "@modelcontextprotocol/sdk/types.js";
import worker, { type Env } from "../../worker";
import { establishSSEConnection } from "../../shared/test-utils";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/**
 * Tests specific to the SSE transport protocol
 */
describe("SSE Transport", () => {
  const baseUrl = "http://example.com/sse";

  describe("Connection Establishment", () => {
    it("should establish connection and return session endpoint", async () => {
      const ctx = createExecutionContext();

      const request = new Request(baseUrl);
      const sseStream = await worker.fetch(request, env, ctx);

      const reader = sseStream.body?.getReader();
      const { done, value } = await reader!.read();
      const event = new TextDecoder().decode(value);

      expect(done).toBe(false);

      const lines = event.split("\n");
      expect(lines[0]).toEqual("event: endpoint");
      expect(lines[1]).toMatch(/^data: \/sse\/message\?sessionId=.*$/);
    });
  });

  describe("Message Handling", () => {
    it("should accept messages and return 202 Accepted", async () => {
      const ctx = createExecutionContext();
      const { sessionId } = await establishSSEConnection(ctx);

      const toolsRequest = new Request(
        `${baseUrl}/message?sessionId=${sessionId}`,
        {
          body: JSON.stringify({
            id: "1",
            jsonrpc: "2.0",
            method: "tools/list"
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST"
        }
      );

      const toolsResponse = await worker.fetch(toolsRequest, env, ctx);
      expect(toolsResponse.status).toBe(202);
      expect(toolsResponse.headers.get("Content-Type")).toBe(
        "text/event-stream"
      );
      expect(await toolsResponse.text()).toBe("Accepted");
    });

    it("should deliver responses via SSE stream", async () => {
      const ctx = createExecutionContext();
      const { sessionId, reader } = await establishSSEConnection(ctx);

      const toolsRequest = new Request(
        `${baseUrl}/message?sessionId=${sessionId}`,
        {
          body: JSON.stringify({
            id: "1",
            jsonrpc: "2.0",
            method: "tools/list"
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST"
        }
      );

      await worker.fetch(toolsRequest, env, ctx);

      const { done, value } = await reader.read();
      expect(done).toBe(false);

      const toolsEvent = new TextDecoder().decode(value);
      const lines = toolsEvent.split("\n");
      expect(lines[0]).toEqual("event: message");

      const jsonResponse = JSON.parse(lines[1].replace("data: ", ""));
      expect(jsonResponse.jsonrpc).toBe("2.0");
      expect(jsonResponse.id).toBe("1");
      expect(jsonResponse.result.tools).toBeDefined();
    });
  });

  describe("Transport-specific Features", () => {
    it("should use separate endpoints for sending vs receiving", async () => {
      const ctx = createExecutionContext();
      const { sessionId } = await establishSSEConnection(ctx);

      // Sending uses POST to /sse/message
      const sendEndpoint = `${baseUrl}/message?sessionId=${sessionId}`;

      // Receiving uses the initial SSE connection
      const request = new Request(sendEndpoint, {
        body: JSON.stringify({
          id: "test",
          jsonrpc: "2.0",
          method: "tools/list"
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(202);

      // This demonstrates the SSE pattern: send via POST, receive via SSE
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    });
  });

  describe("Header and Auth Handling", () => {
    it("should pass headers and session ID to transport via requestInfo", async () => {
      const ctx = createExecutionContext();
      const { sessionId, reader } = await establishSSEConnection(ctx);

      // Send request with custom headers using the echoRequestInfo tool
      const request = new Request(`${baseUrl}/message?sessionId=${sessionId}`, {
        method: "POST",
        body: JSON.stringify({
          id: "echo-headers-1",
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "echoRequestInfo",
            arguments: {}
          }
        }),
        headers: {
          "Content-Type": "application/json",
          "x-user-id": "test-user-123",
          "x-request-id": "req-456",
          "x-custom-header": "custom-value"
        }
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(202); // SSE returns 202 Accepted

      // Read the response from the SSE stream
      const { value } = await reader.read();
      const event = new TextDecoder().decode(value);
      const lines = event.split("\n");
      expect(lines[0]).toEqual("event: message");

      // Parse the JSON response from the data line
      const dataLine = lines.find((line) => line.startsWith("data:"));
      const parsed = JSON.parse(
        dataLine!.replace("data: ", "")
      ) as JSONRPCResponse;
      expect(parsed.id).toBe("echo-headers-1");

      // Extract the echoed request info
      const result = parsed.result as CallToolResult;
      const textContent = result.content?.[0];
      if (!textContent || textContent.type !== "text") {
        throw new Error("Expected text content in tool result");
      }
      const echoedData = JSON.parse(textContent.text);

      // Verify custom headers were passed through
      expect(echoedData.hasRequestInfo).toBe(true);
      expect(echoedData.headers["x-user-id"]).toBe("test-user-123");
      expect(echoedData.headers["x-request-id"]).toBe("req-456");
      expect(echoedData.headers["x-custom-header"]).toBe("custom-value");

      // Verify that certain internal headers that the transport adds are NOT exposed
      // The transport filters cf-mcp-method, cf-mcp-message, and upgrade headers
      expect(echoedData.headers["cf-mcp-method"]).toBeUndefined();
      expect(echoedData.headers["cf-mcp-message"]).toBeUndefined();
      expect(echoedData.headers.upgrade).toBeUndefined();

      // Verify standard headers are also present
      expect(echoedData.headers["content-type"]).toBe("application/json");

      // Check what properties are available in extra
      expect(echoedData.availableExtraKeys).toBeDefined();

      // Verify sessionId is passed through extra data
      expect(echoedData.sessionId).toBeDefined();
      expect(echoedData.sessionId).toBe(sessionId);
    });
  });
});
