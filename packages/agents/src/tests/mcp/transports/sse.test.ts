import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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
});
