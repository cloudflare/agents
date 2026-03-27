import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../worker";
import {
  TEST_MESSAGES,
  sendPostRequest,
  readSSEEvent,
  parseSSEData,
  expectValidToolsList,
  expectValidGreetResult,
  initializeStreamableHTTPServer
} from "../shared/test-utils";

const AUTO_BASE = "http://example.com/auto";

/**
 * Establish a legacy SSE connection via the auto endpoint.
 * GET without mcp-session-id → auto handler routes to SSE.
 */
async function establishSSEViaAuto(ctx: ExecutionContext) {
  const request = new Request(AUTO_BASE);
  const sseStream = await worker.fetch(request, env, ctx);

  expect(sseStream.status).toBe(200);
  expect(sseStream.headers.get("content-type")).toBe("text/event-stream");

  const reader = sseStream.body?.getReader();
  if (!reader) throw new Error("No reader available");

  const { value } = await reader.read();
  const event = new TextDecoder().decode(value);

  const lines = event.split("\n");
  expect(lines[0]).toBe("event: endpoint");
  expect(lines[1]).toContain("/auto/message");

  const sessionId = lines[1].split("=")[1];
  expect(sessionId).toBeDefined();

  return { sessionId, reader };
}

describe("Auto Transport", () => {
  describe("Routing: Streamable HTTP requests", () => {
    it("should handle POST to base path as streamable HTTP", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx, AUTO_BASE);

      const response = await sendPostRequest(
        ctx,
        AUTO_BASE,
        TEST_MESSAGES.toolsList,
        sessionId
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const sseText = await readSSEEvent(response);
      const result = parseSSEData(sseText);
      expectValidToolsList(result);
    });

    it("should handle DELETE as streamable HTTP", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx, AUTO_BASE);

      const deleteReq = new Request(AUTO_BASE, {
        method: "DELETE",
        headers: { "mcp-session-id": sessionId }
      });

      const response = await worker.fetch(deleteReq, env, ctx);
      expect(response.status).toBe(204);
    });

    it("should handle GET with mcp-session-id as streamable HTTP standalone SSE", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx, AUTO_BASE);

      const getReq = new Request(AUTO_BASE, {
        method: "GET",
        headers: {
          Accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId
        }
      });

      const response = await worker.fetch(getReq, env, ctx);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("mcp-session-id")).toBe(sessionId);
    });
  });

  describe("Routing: Legacy SSE requests", () => {
    it("should handle GET without mcp-session-id as legacy SSE", async () => {
      const ctx = createExecutionContext();
      const { sessionId } = await establishSSEViaAuto(ctx);
      expect(sessionId).toBeTruthy();
    });

    it("should handle POST to /message as legacy SSE", async () => {
      const ctx = createExecutionContext();
      const { sessionId, reader } = await establishSSEViaAuto(ctx);

      const postReq = new Request(
        `${AUTO_BASE}/message?sessionId=${sessionId}`,
        {
          method: "POST",
          body: JSON.stringify(TEST_MESSAGES.toolsList),
          headers: { "Content-Type": "application/json" }
        }
      );

      const response = await worker.fetch(postReq, env, ctx);
      expect(response.status).toBe(202);

      const { value } = await reader.read();
      const event = new TextDecoder().decode(value);
      const result = JSON.parse(event.split("\n")[1].replace("data: ", ""));
      expectValidToolsList(result);
    });
  });

  describe("Protocol: full tool invocation through auto", () => {
    it("should invoke greet tool via streamable HTTP through auto", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx, AUTO_BASE);

      const response = await sendPostRequest(
        ctx,
        AUTO_BASE,
        TEST_MESSAGES.greetTool,
        sessionId
      );

      expect(response.status).toBe(200);
      const sseText = await readSSEEvent(response);
      const result = parseSSEData(sseText);
      expectValidGreetResult(result, "Test User");
    });

    it("should invoke greet tool via legacy SSE through auto", async () => {
      const ctx = createExecutionContext();
      const { sessionId, reader } = await establishSSEViaAuto(ctx);

      const greetReq = new Request(
        `${AUTO_BASE}/message?sessionId=${sessionId}`,
        {
          method: "POST",
          body: JSON.stringify(TEST_MESSAGES.greetTool),
          headers: { "Content-Type": "application/json" }
        }
      );

      const response = await worker.fetch(greetReq, env, ctx);
      expect(response.status).toBe(202);

      const { value } = await reader.read();
      const event = new TextDecoder().decode(value);
      const result = JSON.parse(event.split("\n")[1].replace("data: ", ""));
      expectValidGreetResult(result, "Test User");
    });
  });

  describe("Coexistence: both transports on the same path", () => {
    it("should serve streamable HTTP and SSE clients simultaneously", async () => {
      const ctx = createExecutionContext();

      const streamableSessionId = await initializeStreamableHTTPServer(
        ctx,
        AUTO_BASE
      );

      const { sessionId: sseSessionId, reader: sseReader } =
        await establishSSEViaAuto(ctx);

      const streamableResponse = await sendPostRequest(
        ctx,
        AUTO_BASE,
        TEST_MESSAGES.greetTool,
        streamableSessionId
      );
      expect(streamableResponse.status).toBe(200);
      const streamableText = await readSSEEvent(streamableResponse);
      const streamableResult = parseSSEData(streamableText);
      expectValidGreetResult(streamableResult, "Test User");

      const sseReq = new Request(
        `${AUTO_BASE}/message?sessionId=${sseSessionId}`,
        {
          method: "POST",
          body: JSON.stringify(TEST_MESSAGES.greetTool),
          headers: { "Content-Type": "application/json" }
        }
      );
      const sseResponse = await worker.fetch(sseReq, env, ctx);
      expect(sseResponse.status).toBe(202);

      const { value } = await sseReader.read();
      const sseEvent = new TextDecoder().decode(value);
      const sseResult = JSON.parse(
        sseEvent.split("\n")[1].replace("data: ", "")
      );
      expectValidGreetResult(sseResult, "Test User");
    });
  });

  describe("Notifications and non-request messages", () => {
    it("should return 202 for notification-only POST via streamable HTTP", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx, AUTO_BASE);

      const notification = {
        jsonrpc: "2.0",
        method: "notifications/initialized"
      };

      const response = await sendPostRequest(
        ctx,
        AUTO_BASE,
        notification as unknown as import("@modelcontextprotocol/sdk/types.js").JSONRPCMessage,
        sessionId
      );

      expect(response.status).toBe(202);
    });
  });

  describe("CORS", () => {
    it("should handle OPTIONS preflight through auto endpoint", async () => {
      const ctx = createExecutionContext();

      const optionsReq = new Request(AUTO_BASE, { method: "OPTIONS" });
      const response = await worker.fetch(optionsReq, env, ctx);

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
        "POST"
      );
      expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
        "DELETE"
      );
      expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
        "mcp-session-id"
      );
    });

    it("should include Allow header on 405 responses", async () => {
      const ctx = createExecutionContext();

      const putReq = new Request(AUTO_BASE, { method: "PUT" });
      const response = await worker.fetch(putReq, env, ctx);

      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, POST, DELETE");
    });
  });

  describe("Edge cases", () => {
    it("should return 405 for unsupported methods", async () => {
      const ctx = createExecutionContext();

      const putReq = new Request(AUTO_BASE, { method: "PUT" });
      const response = await worker.fetch(putReq, env, ctx);
      expect(response.status).toBe(405);
    });

    it("should return 400 for DELETE without mcp-session-id", async () => {
      const ctx = createExecutionContext();

      const deleteReq = new Request(AUTO_BASE, { method: "DELETE" });
      const response = await worker.fetch(deleteReq, env, ctx);
      expect(response.status).toBe(400);
    });

    it("should return 404 for DELETE with unknown session", async () => {
      const ctx = createExecutionContext();

      const deleteReq = new Request(AUTO_BASE, {
        method: "DELETE",
        headers: { "mcp-session-id": "nonexistent-session-id" }
      });
      const response = await worker.fetch(deleteReq, env, ctx);
      expect(response.status).toBe(404);
    });

    it("should return 404 for POST with unknown session via streamable HTTP", async () => {
      const ctx = createExecutionContext();

      const response = await sendPostRequest(
        ctx,
        AUTO_BASE,
        TEST_MESSAGES.toolsList,
        "nonexistent-session-id"
      );
      expect(response.status).toBe(404);
    });

    it("should reject streamable HTTP POST without proper Accept header", async () => {
      const ctx = createExecutionContext();

      const request = new Request(AUTO_BASE, {
        method: "POST",
        body: JSON.stringify(TEST_MESSAGES.initialize),
        headers: { "Content-Type": "application/json" }
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(406);
    });

    it("should reject SSE POST to /message without sessionId", async () => {
      const ctx = createExecutionContext();

      const request = new Request(`${AUTO_BASE}/message`, {
        method: "POST",
        body: JSON.stringify(TEST_MESSAGES.toolsList),
        headers: { "Content-Type": "application/json" }
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(400);
    });
  });
});
