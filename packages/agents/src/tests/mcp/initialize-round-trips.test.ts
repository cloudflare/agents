import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createStreamingHttpHandler } from "../../mcp/server/utils";
import { TEST_MESSAGES } from "../shared/test-utils";

function countingNamespace(calls: string[]) {
  const wrapStub = (stub: object) =>
    new Proxy(stub, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (typeof prop !== "string" || typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]) => {
          calls.push(prop);
          return (
            target as unknown as Record<string, (...a: unknown[]) => unknown>
          )[prop](...args);
        };
      }
    });
  const ns = env.MCP_OBJECT;
  return new Proxy(ns, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(
          target,
          args
        );
        return prop === "get" || prop === "getByName"
          ? wrapStub(result as object)
          : result;
      };
    }
  });
}

describe("streamable HTTP initialize", () => {
  it("starts a session with two calls to its Durable Object", async () => {
    const calls: string[] = [];
    const handler = createStreamingHttpHandler(
      "/mcp",
      countingNamespace(calls) as unknown as typeof env.MCP_OBJECT
    );
    const response = await handler(
      new Request("http://example.com/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream"
        },
        body: JSON.stringify(TEST_MESSAGES.initialize)
      }),
      createExecutionContext()
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeTruthy();
    // The upgrade stores the initialize request, so the handler neither
    // reads nor writes it in calls of its own.
    expect(calls).toEqual(["__unsafe_ensureInitialized", "fetch"]);
  });
});
