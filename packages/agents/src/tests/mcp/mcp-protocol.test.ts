import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../worker";
import {
  TEST_MESSAGES,
  initializeStreamableHTTPServer,
  establishSSEConnection,
  sendPostRequest,
  readSSEEvent,
  parseSSEData,
  expectValidToolsList,
  expectValidGreetResult,
  expectValidPropsResult,
  establishRPCConnection
} from "../shared/test-utils";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/**
 * Core MCP protocol tests that should work regardless of transport
 */
describe("MCP Protocol Core Functionality", () => {
  describe("Tool Operations", () => {
    it("should list available tools via streamable HTTP", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx);

      const response = await sendPostRequest(
        ctx,
        "http://example.com/mcp",
        TEST_MESSAGES.toolsList,
        sessionId
      );

      expect(response.status).toBe(200);
      const sseText = await readSSEEvent(response);
      const result = parseSSEData(sseText);

      expectValidToolsList(result);
    });

    it("should list available tools via SSE", async () => {
      const ctx = createExecutionContext();
      const { sessionId, reader } = await establishSSEConnection(ctx);

      const toolsRequest = new Request(
        `http://example.com/sse/message?sessionId=${sessionId}`,
        {
          body: JSON.stringify(TEST_MESSAGES.toolsList),
          headers: { "Content-Type": "application/json" },
          method: "POST"
        }
      );

      const toolsResponse = await worker.fetch(toolsRequest, env, ctx);
      expect(toolsResponse.status).toBe(202);

      const { value } = await reader.read();
      const toolsEvent = new TextDecoder().decode(value);
      const result = JSON.parse(
        toolsEvent.split("\n")[1].replace("data: ", "")
      );

      expectValidToolsList(result);
    });

    it("should list available tools via RPC", async () => {
      const { connection } = await establishRPCConnection();

      const result = await connection.client.listTools();

      expectValidToolsList({
        jsonrpc: "2.0",
        id: "tools-1",
        result
      });
    });

    it("should invoke greet tool via streamable HTTP", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx);

      const response = await sendPostRequest(
        ctx,
        "http://example.com/mcp",
        TEST_MESSAGES.greetTool,
        sessionId
      );

      expect(response.status).toBe(200);
      const sseText = await readSSEEvent(response);
      const result = parseSSEData(sseText);

      expectValidGreetResult(result, "Test User");
    });

    it("should invoke greet tool via SSE", async () => {
      const ctx = createExecutionContext();
      const { sessionId, reader } = await establishSSEConnection(ctx);

      const greetRequest = new Request(
        `http://example.com/sse/message?sessionId=${sessionId}`,
        {
          body: JSON.stringify(TEST_MESSAGES.greetTool),
          headers: { "Content-Type": "application/json" },
          method: "POST"
        }
      );

      const greetResponse = await worker.fetch(greetRequest, env, ctx);
      expect(greetResponse.status).toBe(202);

      const { value } = await reader.read();
      const greetEvent = new TextDecoder().decode(value);
      const result = JSON.parse(
        greetEvent.split("\n")[1].replace("data: ", "")
      );

      expectValidGreetResult(result, "Test User");
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
  });

  describe("Props Passing", () => {
    it("should pass props to agent via streamable HTTP", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx);

      const response = await sendPostRequest(
        ctx,
        "http://example.com/mcp",
        TEST_MESSAGES.propsTestTool,
        sessionId
      );

      expect(response.status).toBe(200);
      const sseText = await readSSEEvent(response);
      const result = parseSSEData(sseText);

      expectValidPropsResult(result);
    });

    it("should pass props to agent via SSE", async () => {
      const ctx = createExecutionContext();
      const { sessionId, reader } = await establishSSEConnection(ctx);

      const propsRequest = new Request(
        `http://example.com/sse/message?sessionId=${sessionId}`,
        {
          body: JSON.stringify(TEST_MESSAGES.propsTestTool),
          headers: { "Content-Type": "application/json" },
          method: "POST"
        }
      );

      const propsResponse = await worker.fetch(propsRequest, env, ctx);
      expect(propsResponse.status).toBe(202);

      const { value } = await reader.read();
      const propsEvent = new TextDecoder().decode(value);
      const result = JSON.parse(
        propsEvent.split("\n")[1].replace("data: ", "")
      );

      expectValidPropsResult(result);
    });
  });
});
