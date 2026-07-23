/**
 * Forced eviction coverage for the stateful McpAgent transport.
 *
 * This verifies reconstruction after a test-requested actor teardown. It does
 * not assert natural idle hibernation or hibernation eligibility.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../..";
import worker from "../worker";
import { initializeStreamableHTTPServer } from "../shared/test-utils";

describe("McpAgent recovery after forced Durable Object eviction", () => {
  it("restores the initialize request and continues the HTTP session", async () => {
    const ctx = createExecutionContext();
    const baseUrl = "http://example.com/mcp";
    const sessionId = await initializeStreamableHTTPServer(ctx, baseUrl);
    const name = `streamable-http:${sessionId}`;
    let stub = await getAgentByName(env.MCP_OBJECT, name);

    const initializeRequest = await stub.getInitializeRequest();
    expect(initializeRequest).toBeDefined();

    await evictDurableObject(stub);

    stub = await getAgentByName(env.MCP_OBJECT, name);
    expect(await stub.getInitializeRequest()).toEqual(initializeRequest);

    const response = await worker.fetch(
      new Request(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1234,
          method: "tools/call",
          params: { name: "greet", arguments: { name: "Evicted" } }
        })
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Hello, Evicted!");
  });
});
