import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import worker, { type Env } from "../../worker";
import { initializeMCPClientConnection } from "../../shared/test-utils";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/**
 * Tests for the "auto" transport mode which attempts streamable-http first,
 * then falls back to SSE if streamable-http returns 404 or 405 errors
 */
describe("Auto Transport Mode", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const ctx = createExecutionContext();
      const request = new Request(input, init);
      return worker.fetch(request, env, ctx);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("Transport Selection Logic", () => {
    it("should use connect using streamable-http when available", async () => {
      const connection = await initializeMCPClientConnection(
        "http://example.com/mcp",
        "auto"
      );

      await connection.init();

      expect(connection.connectionState).toBe("connected");

      // Trigger discovery
      await connection.discover();

      expect(connection.connectionState).toBe("ready");
      expect(connection.tools).toBeDefined();
    });

    it("should use connect using sse when available", async () => {
      const connection = await initializeMCPClientConnection(
        "http://example.com/sse",
        "auto"
      );

      await connection.init();

      expect(connection.connectionState).toBe("connected");

      // Trigger discovery
      await connection.discover();

      expect(connection.connectionState).toBe("ready");
      expect(connection.tools).toBeDefined();
    });

    it("should not fallback for 5XX errors", async () => {
      const connection = await initializeMCPClientConnection(
        "http://example.com/500",
        "auto"
      );

      await connection.init();
      expect(connection.connectionState).toBe("failed");
    });

    it("should fail when endpoint returns 404 for both streamable-http and sse", async () => {
      const connection = await initializeMCPClientConnection(
        "http://example.com/not-found",
        "auto"
      );

      await connection.init();
      expect(connection.connectionState).toBe("failed");
    });

    it("should fail when asking for an incorrect transport type", async () => {
      const connection = await initializeMCPClientConnection(
        "http://example.com/mcp",
        "sse"
      );

      await connection.init();
      expect(connection.connectionState).toBe("failed");
    });
  });
});
