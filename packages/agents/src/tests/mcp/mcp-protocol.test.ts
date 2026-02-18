import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../worker";
import {
  TEST_MESSAGES,
  initializeStreamableHTTPServer,
  sendPostRequest,
  readSSEEvent,
  parseSSEData,
  expectValidToolsList,
  expectValidGreetResult,
  expectValidPropsResult
} from "../shared/test-utils";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/**
 * Core MCP protocol tests for Streamable HTTP transport
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
  });
});
