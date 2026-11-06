import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createStreamingHttpHandler } from "../../mcp/server/utils";
import { TEST_MESSAGES } from "../shared/test-utils";

function countingNamespace(calls: string[]) {
  const wrapStub = (stub: object) =>
    new Proxy(stub, {
      get(target, prop) {
        if (prop === "getInitializeRequest") {
          return () => {
            calls.push(prop);
            return (
              target as unknown as {
                getInitializeRequest(): Promise<unknown>;
              }
            ).getInitializeRequest();
          };
        }
        const value = Reflect.get(target, prop);
        return prop === "fetch" ? (value as Function).bind(target) : value;
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
  it("does not read the stored initialize request", async () => {
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
    expect(calls).toEqual([]);
  });
});
