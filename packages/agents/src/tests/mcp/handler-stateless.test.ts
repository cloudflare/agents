import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer, SERVER_INFO_META_KEY } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "../../mcp";
import { afterEach, describe, expect, it, vi } from "vitest";

const VERIFIED_OAUTH_CONTEXT = Symbol.for(
  "cloudflare.workers-oauth-provider.verified-context.v1"
);

function legacyInitializeRequest(id = 1) {
  return new Request("http://example.com/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" }
      }
    })
  });
}

function legacyToolRequest(name: string) {
  return new Request("http://example.com/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: {} }
    })
  });
}

function statelessRequest(
  method: string,
  params: Record<string, unknown> = {}
) {
  const name = typeof params.name === "string" ? params.name : undefined;
  return new Request("http://example.com/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(name && { "Mcp-Name": name })
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "test",
            version: "1.0.0"
          },
          "io.modelcontextprotocol/clientCapabilities": {}
        }
      }
    })
  });
}

function createServer() {
  return new McpServer({ name: "test", version: "1.0.0" });
}

describe("createMcpHandler SDK v2", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("serves the Stateless protocol from an upstream server", async () => {
    const handler = createMcpHandler(() => createServer());

    const response = await handler(
      statelessRequest("server/discover"),
      env,
      createExecutionContext()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        supportedVersions: ["2026-07-28"],
        _meta: {
          [SERVER_INFO_META_KEY]: { name: "test", version: "1.0.0" }
        }
      }
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("preserves upstream Legacy compatibility serving by default", async () => {
    const handler = createMcpHandler(() => createServer());

    const response = await handler(
      legacyInitializeRequest(),
      env,
      createExecutionContext()
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"protocolVersion":"2025-11-25"');
  });

  it("rejects session methods without constructing a Legacy compatibility server", async () => {
    let factoryCalls = 0;
    const handler = createMcpHandler(() => {
      factoryCalls++;
      return createServer();
    });

    for (const method of ["GET", "DELETE"]) {
      const response = await handler.fetch(
        new Request("http://example.com/mcp", {
          method,
          headers: { Accept: "text/event-stream" }
        })
      );

      expect(response.status).toBe(405);
      expect(await response.json()).toMatchObject({
        error: { code: -32000, message: "Method not allowed." },
        id: null,
        jsonrpc: "2.0"
      });
    }
    expect(factoryCalls).toBe(0);
  });

  it("fails fast when Legacy compatibility code attempts a reverse request", async () => {
    const handler = createMcpHandler(() => {
      const server = createServer();
      server.registerTool("push", { inputSchema: {} }, async (_args, ctx) => {
        try {
          await ctx.mcpReq.send({
            method: "sampling/createMessage",
            params: {
              messages: [
                {
                  role: "user",
                  content: { type: "text", text: "hello" }
                }
              ],
              maxTokens: 10
            }
          });
          return { content: [{ type: "text", text: "unexpected" }] };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error)
              }
            ]
          };
        }
      });
      return server;
    });

    const response = await handler(
      legacyToolRequest("push"),
      env,
      createExecutionContext()
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Server-to-client requests are unavailable");
    expect(body).toContain("sessionful transport");
  });

  it("keeps long-running Legacy compatibility POST streams alive", async () => {
    let releaseTool!: () => void;
    const toolReleased = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const handler = createMcpHandler(() => {
      const server = createServer();
      server.registerTool("hang", { inputSchema: {} }, async () => {
        await toolReleased;
        return { content: [{ type: "text" as const, text: "done" }] };
      });
      return server;
    });

    vi.useFakeTimers();
    const response = await handler.fetch(legacyToolRequest("hang"));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const drain = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
      }
    })();

    await vi.advanceTimersByTimeAsync(51_000);
    releaseTool();
    await drain;

    expect(buffered).toContain(": keepalive\n\n");
    expect(buffered).not.toContain("event: ping");
    await handler.close();
  });

  it("clears a Legacy compatibility keepalive when the response is cancelled", async () => {
    let releaseTool!: () => void;
    const toolReleased = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    const handler = createMcpHandler(() => {
      const server = createServer();
      server.registerTool("hang", { inputSchema: {} }, async () => {
        await toolReleased;
        return { content: [{ type: "text" as const, text: "done" }] };
      });
      return server;
    });
    const response = await handler.fetch(legacyToolRequest("hang"));

    await response.body!.cancel();

    expect(clearInterval).toHaveBeenCalled();
    releaseTool();
    await handler.close();
  });

  it("supports strict Stateless-only serving", async () => {
    const handler = createMcpHandler(() => createServer(), {
      legacy: "reject"
    });

    const response = await handler(
      legacyInitializeRequest(),
      env,
      createExecutionContext()
    );

    expect(response.status).toBe(400);
  });

  it("applies route and CORS behavior through callable and fetch faces", async () => {
    const handler = createMcpHandler(() => createServer(), {
      route: "/custom",
      corsOptions: { origin: "https://client.example" },
      allowedOriginHostnames: ["client.example"]
    });
    const ctx = createExecutionContext();

    const missing = await handler(
      new Request("http://example.com/mcp", { method: "OPTIONS" }),
      env,
      ctx
    );
    const preflight = await handler.fetch(
      new Request("http://example.com/custom", {
        method: "OPTIONS",
        headers: { Origin: "https://client.example" }
      }),
      env,
      ctx
    );

    expect(missing.status).toBe(404);
    expect(preflight.status).toBe(200);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://client.example"
    );
  });

  it("allows Stateless standard request headers in CORS preflight", async () => {
    const handler = createMcpHandler(() => createServer());

    const response = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "OPTIONS",
        headers: {
          Host: "localhost",
          Origin: "http://localhost:3000",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "mcp-method, mcp-name"
        }
      })
    );
    const allowedHeaders = response.headers
      .get("Access-Control-Allow-Headers")
      ?.toLowerCase()
      .split(/,\s*/);

    expect(response.status).toBe(200);
    expect(allowedHeaders).toEqual(
      expect.arrayContaining(["mcp-method", "mcp-name"])
    );
  });

  it("accepts the endpoint workers.dev Origin by default", async () => {
    const handler = createMcpHandler(() => createServer());
    const request = statelessRequest("server/discover");
    const workersDevRequest = new Request(
      request.url.replace("example.com", "server.account.workers.dev"),
      request
    );
    workersDevRequest.headers.set("Host", "server.account.workers.dev");
    workersDevRequest.headers.set(
      "Origin",
      "https://server.account.workers.dev"
    );

    const response = await handler.fetch(workersDevRequest);

    expect(response.status).toBe(200);
  });

  it("derives a custom-domain Origin allowlist from concrete CORS config", async () => {
    const handler = createMcpHandler(() => createServer(), {
      corsOptions: { origin: "https://app.example.com" }
    });
    const request = statelessRequest("server/discover");
    request.headers.set("Origin", "https://app.example.com:8443");

    const response = await handler.fetch(request);

    expect(response.status).toBe(200);
  });

  it("keeps the SDK localhost Host and Origin guards for local endpoints", async () => {
    const handler = createMcpHandler(() => createServer());
    const request = statelessRequest("server/discover");
    const localRequest = new Request(
      request.url.replace("example.com", "localhost"),
      request
    );
    localRequest.headers.set("Origin", "https://evil.example.com");

    const originResponse = await handler.fetch(localRequest);
    expect(originResponse.status).toBe(403);

    localRequest.headers.set("Origin", "http://localhost:3000");
    localRequest.headers.set("Host", "evil.example.com");
    const hostResponse = await handler.fetch(localRequest);
    expect(hostResponse.status).toBe(403);
  });

  it("rejects an Origin outside an explicit deployment allowlist", async () => {
    let factoryCalled = false;
    const handler = createMcpHandler(
      () => {
        factoryCalled = true;
        return createServer();
      },
      { allowedOriginHostnames: ["client.example"] }
    );
    const request = statelessRequest("server/discover");
    request.headers.set("Origin", "http://evil.example.com");

    const response = await handler.fetch(request);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        code: -32000,
        message: expect.stringContaining("Invalid Origin")
      },
      id: null,
      jsonrpc: "2.0"
    });
    expect(factoryCalled).toBe(false);
  });

  it("rejects a malformed or opaque Origin", async () => {
    const handler = createMcpHandler(() => createServer());
    const request = statelessRequest("server/discover");
    request.headers.set("Origin", "null");

    const response = await handler.fetch(request);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        code: -32000,
        message: expect.stringContaining("Invalid Origin header")
      }
    });
  });

  it("accepts a present Origin on the configured hostname allowlist", async () => {
    const handler = createMcpHandler(() => createServer(), {
      allowedOriginHostnames: ["client.example"]
    });
    const request = statelessRequest("server/discover");
    request.headers.set("Origin", "https://client.example:8443");

    const response = await handler.fetch(request);

    expect(response.status).toBe(200);
  });

  it.each(["https://any.example", "null", "not a url"])(
    "allows Origin %s when validation is explicitly disabled",
    async (origin) => {
      const handler = createMcpHandler(() => createServer(), {
        allowedOriginHostnames: "*"
      });
      const request = statelessRequest("server/discover");
      request.headers.set("Origin", origin);

      const response = await handler.fetch(request);

      expect(response.status).toBe(200);
    }
  );

  it("exposes the upstream close, notify, and bus controls", () => {
    const handler = createMcpHandler(() => createServer());

    expect(typeof handler.close).toBe("function");
    expect(typeof handler.notify.toolsChanged).toBe("function");
    expect(typeof handler.bus.publish).toBe("function");
  });

  it("does not construct a Legacy compatibility server for an aborted request", async () => {
    let factoryCalls = 0;
    const handler = createMcpHandler(() => {
      factoryCalls++;
      return createServer();
    });
    const controller = new AbortController();
    const request = legacyInitializeRequest();
    const aborted = new Request(request, { signal: controller.signal });
    controller.abort();

    const response = await handler.fetch(aborted);

    expect(response.status).toBe(499);
    expect(factoryCalls).toBe(0);
  });

  it("does not serve Legacy compatibility requests after close", async () => {
    let factoryCalls = 0;
    const handler = createMcpHandler(() => {
      factoryCalls++;
      return createServer();
    });

    await handler.close();

    await expect(handler.fetch(legacyInitializeRequest())).rejects.toThrow(
      "This MCP handler has been closed"
    );
    expect(factoryCalls).toBe(0);
  });

  it("does not start a legacy server when close wins request classification", async () => {
    let factoryCalls = 0;
    let releaseClassification!: () => void;
    let markClassificationStarted!: () => void;
    const classificationStarted = new Promise<void>((resolve) => {
      markClassificationStarted = resolve;
    });
    const classificationGate = new Promise<void>((resolve) => {
      releaseClassification = resolve;
    });
    const request = legacyInitializeRequest();
    const cloneRequest = request.clone.bind(request);
    Object.defineProperty(request, "clone", {
      value: () => {
        const clone = cloneRequest();
        const readBody = clone.text.bind(clone);
        Object.defineProperty(clone, "text", {
          value: async () => {
            markClassificationStarted();
            await classificationGate;
            return readBody();
          }
        });
        return clone;
      }
    });
    const handler = createMcpHandler(() => {
      factoryCalls++;
      return createServer();
    });
    const pendingResponse = handler.fetch(request);
    await classificationStarted;

    await handler.close();
    releaseClassification();

    await expect(pendingResponse).rejects.toThrow(
      "This MCP handler has been closed"
    );
    expect(factoryCalls).toBe(0);
  });

  it("closes active Legacy compatibility servers", async () => {
    let serverClosed = false;
    const handler = createMcpHandler(() => {
      const server = createServer();
      server.server.onclose = () => {
        serverClosed = true;
      };
      return server;
    });
    const response = await handler.fetch(legacyInitializeRequest());

    await handler.close();

    expect(serverClosed).toBe(true);
    await response.body?.cancel();
  });

  it("closes a Legacy compatibility server whose factory resolves during close", async () => {
    let resolveFactory!: (server: McpServer) => void;
    let markFactoryStarted!: () => void;
    const factoryStarted = new Promise<void>((resolve) => {
      markFactoryStarted = resolve;
    });
    let serverClosed = false;
    const handler = createMcpHandler(() => {
      markFactoryStarted();
      return new Promise<McpServer>((resolve) => {
        resolveFactory = resolve;
      });
    });
    const pendingResponse = handler.fetch(legacyInitializeRequest());
    await factoryStarted;
    const closing = handler.close();
    const server = createServer();
    const closeServer = server.close.bind(server);
    server.close = async () => {
      serverClosed = true;
      await closeServer();
    };

    resolveFactory(server);
    await closing;
    await pendingResponse;

    expect(serverClosed).toBe(true);
  });

  it("requires a factory for SDK v2 servers", () => {
    expect(() => createMcpHandler(createServer() as never)).toThrow(
      "Pass a factory returning McpServer or Server"
    );
  });

  it("constructs an isolated server for each factory request", async () => {
    let calls = 0;
    const handler = createMcpHandler(() => {
      calls++;
      return createServer();
    });

    const [first, second] = await Promise.all([
      handler(
        statelessRequest("server/discover"),
        env,
        createExecutionContext()
      ),
      handler(
        statelessRequest("server/discover"),
        env,
        createExecutionContext()
      )
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("passes explicit AuthInfo through the upstream fetch face", async () => {
    let seenFactoryContext: unknown;
    const handler = createMcpHandler((factoryContext) => {
      seenFactoryContext = factoryContext;
      return createServer();
    });
    const authInfo = {
      token: "explicit-token",
      clientId: "explicit-client",
      scopes: ["read"]
    };

    const response = await handler.fetch(statelessRequest("server/discover"), {
      authInfo
    });

    expect(response.status).toBe(200);
    expect(seenFactoryContext).toMatchObject({ authInfo });
  });

  it("maps verified provider metadata to AuthInfo and preserves props", async () => {
    const props = { userId: "user-1" };
    const ctx = createExecutionContext() as ExecutionContext &
      Record<symbol, unknown>;
    Object.defineProperty(ctx, "props", { value: props });
    Object.defineProperty(ctx, VERIFIED_OAUTH_CONTEXT, {
      value: {
        version: 1,
        token: "secret-token",
        clientId: "client-1",
        scopes: ["read"],
        expiresAt: 1234567890,
        resource: "https://example.com/mcp",
        props
      }
    });
    let seenFactoryContext: unknown;
    let seenToolContext: unknown;
    let seenAuthProps: unknown;
    const handler = createMcpHandler((factoryContext) => {
      seenFactoryContext = factoryContext;
      const server = createServer();
      server.registerTool(
        "whoami",
        { inputSchema: {} },
        (_args, toolContext) => {
          seenToolContext = toolContext;
          seenAuthProps = getMcpAuthContext()?.props;
          return { content: [{ type: "text", text: "ok" }] };
        }
      );
      return server;
    });

    const response = await handler(
      statelessRequest("tools/call", { name: "whoami", arguments: {} }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    const expected = {
      token: "secret-token",
      clientId: "client-1",
      scopes: ["read"],
      expiresAt: 1234567890,
      resource: new URL("https://example.com/mcp"),
      extra: { props }
    };
    expect(seenFactoryContext).toMatchObject({ authInfo: expected });
    expect(seenToolContext).toMatchObject({ http: { authInfo: expected } });
    expect(seenAuthProps).toBe(props);
  });

  it("maps provider metadata through the v2 server's legacy fallback", async () => {
    const props = { userId: "legacy-auth-user" };
    const ctx = createExecutionContext() as ExecutionContext &
      Record<symbol, unknown>;
    Object.defineProperty(ctx, "props", { value: props });
    Object.defineProperty(ctx, VERIFIED_OAUTH_CONTEXT, {
      value: {
        version: 1,
        token: "legacy-auth-token",
        clientId: "legacy-auth-client",
        scopes: ["read"],
        props
      }
    });
    let seenFactoryContext: unknown;
    let seenToolContext: unknown;
    let seenAuthProps: unknown;
    const handler = createMcpHandler((factoryContext) => {
      seenFactoryContext = factoryContext;
      const server = createServer();
      server.registerTool(
        "whoami",
        { inputSchema: {} },
        (_args, toolContext) => {
          seenToolContext = toolContext;
          seenAuthProps = getMcpAuthContext()?.props;
          return { content: [{ type: "text", text: "ok" }] };
        }
      );
      return server;
    });

    const response = await handler(legacyToolRequest("whoami"), env, ctx);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ok");
    expect(seenFactoryContext).toMatchObject({
      era: "legacy",
      authInfo: {
        token: "legacy-auth-token",
        clientId: "legacy-auth-client",
        scopes: ["read"],
        extra: { props }
      }
    });
    expect(seenToolContext).toMatchObject({
      http: {
        authInfo: {
          clientId: "legacy-auth-client",
          extra: { props }
        }
      }
    });
    expect(seenAuthProps).toBe(props);
  });

  it("rejects v1-only options for a v2 server", () => {
    expect(() =>
      createMcpHandler(() => createServer(), {
        transport: {}
      } as never)
    ).toThrow('option "transport" is only supported with an MCP SDK v1 server');
  });

  it("fails closed on malformed verified metadata", async () => {
    const ctx = createExecutionContext() as ExecutionContext &
      Record<symbol, unknown>;
    Object.defineProperty(ctx, VERIFIED_OAUTH_CONTEXT, {
      value: { version: 1, token: "secret-token" }
    });
    let factoryCalled = false;
    const handler = createMcpHandler(() => {
      factoryCalled = true;
      return createServer();
    });

    const response = await handler(
      statelessRequest("server/discover"),
      env,
      ctx
    );

    expect(response.status).toBe(500);
    expect(factoryCalled).toBe(false);
    expect(await response.text()).not.toContain("secret-token");
  });

  it("keeps external-token props behavior when no verified record exists", async () => {
    const props = { userId: "external-user" };
    const ctx = createExecutionContext();
    Object.defineProperty(ctx, "props", { value: props });
    let seenFactoryContext: unknown;
    let seenProps: unknown;
    const handler = createMcpHandler((factoryContext) => {
      seenFactoryContext = factoryContext;
      seenProps = getMcpAuthContext()?.props;
      return createServer();
    });

    const response = await handler(
      statelessRequest("server/discover"),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    expect(seenFactoryContext).not.toHaveProperty("authInfo");
    expect(seenProps).toBe(props);
  });
});

describe("createMcpHandler deprecated SDK v1 overload", () => {
  it("forwards SDK v1 server inputs to the legacy handler", async () => {
    const server = new LegacyMcpServer({ name: "legacy", version: "1.0.0" });
    const handler = createMcpHandler(server, { enableJsonResponse: true });

    const response = await handler(
      legacyInitializeRequest(),
      env,
      createExecutionContext()
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  it("rejects unsupported server lookalikes", () => {
    expect(() => createMcpHandler({} as never)).toThrow("unsupported server");
  });
});
