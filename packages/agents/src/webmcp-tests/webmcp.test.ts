import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { registerWebMcp } from "../experimental/webmcp";

// ── Helpers ──────────────────────────────────────────────────────────

/** Build a JSON-RPC response body. */
function jsonRpcResult(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

/** Wrap a body string as an SSE `data:` frame. */
function sseFrame(body: string): string {
  return `data: ${body}\n\n`;
}

/** Create a mock Response that behaves like an SSE stream. */
function mockSseResponse(body: string, sessionId = "test-session"): Response {
  return new Response(sseFrame(body), {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "mcp-session-id": sessionId
    }
  });
}

/** Create a mock Response for plain JSON. */
function mockJsonResponse(body: string, sessionId = "test-session"): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "mcp-session-id": sessionId
    }
  });
}

/** Standard tools/list result with two tools. */
const TOOLS_LIST_RESULT = {
  tools: [
    {
      name: "greet",
      description: "Greet someone",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"]
      }
    },
    {
      name: "add",
      description: "Add a number",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" } },
        required: ["a"]
      }
    }
  ]
};

// ── Mock setup ───────────────────────────────────────────────────────

let fetchCallIndex: number;
let fetchResponses: Array<() => Response>;
let fetchRequests: Array<{
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}>;

function setupFetchMock(responses: Array<() => Response>) {
  fetchCallIndex = 0;
  fetchResponses = responses;
  fetchRequests = [];

  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = init?.body
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : {};
      const headers = (init?.headers ?? {}) as Record<string, string>;
      fetchRequests.push({ url, body, headers });

      if (fetchCallIndex >= fetchResponses.length) {
        throw new Error(`Unexpected fetch call #${fetchCallIndex}`);
      }
      return fetchResponses[fetchCallIndex++]();
    }
  ) as unknown as typeof fetch;
}

/** Mock navigator.modelContext with spy functions. */
function mockModelContext() {
  const registeredTools = new Map<string, unknown>();
  const mock = {
    registerTool: vi.fn((tool: { name: string }) => {
      registeredTools.set(tool.name, tool);
    }),
    unregisterTool: vi.fn((name: string) => {
      registeredTools.delete(name);
    }),
    _registeredTools: registeredTools
  };
  Object.defineProperty(navigator, "modelContext", {
    value: mock,
    writable: true,
    configurable: true
  });
  return mock;
}

function clearModelContext() {
  Object.defineProperty(navigator, "modelContext", {
    value: undefined,
    writable: true,
    configurable: true
  });
}

// ── Globals needed by McpHttpClient ──────────────────────────────────

beforeEach(() => {
  // Suppress adapter logs during tests
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  // McpHttpClient resolves relative URLs against location.origin
  if (!globalThis.location) {
    Object.defineProperty(globalThis, "location", {
      value: { origin: "http://localhost:3000" },
      writable: true,
      configurable: true
    });
  }
});

afterEach(() => {
  clearModelContext();
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("registerWebMcp", () => {
  describe("when navigator.modelContext is unavailable", () => {
    it("returns a no-op handle with empty tools", async () => {
      clearModelContext();

      const handle = await registerWebMcp({ url: "/mcp" });

      expect(handle.tools).toEqual([]);
      // refresh and dispose should not throw
      await handle.refresh();
      handle.dispose();
    });

    it("does not call fetch at all", async () => {
      clearModelContext();
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      await registerWebMcp({ url: "/mcp" });

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("when navigator.modelContext is available", () => {
    it("discovers tools and registers them with modelContext", async () => {
      const mc = mockModelContext();

      setupFetchMock([
        // initialize
        () =>
          mockSseResponse(
            jsonRpcResult(1, {
              protocolVersion: "2024-11-05",
              capabilities: {},
              serverInfo: { name: "test", version: "1.0" }
            })
          ),
        // notifications/initialized (no id, returns null)
        () => mockJsonResponse(""),
        // tools/list
        () => mockSseResponse(jsonRpcResult(2, TOOLS_LIST_RESULT))
      ]);

      const handle = await registerWebMcp({
        url: "/mcp",
        watch: false
      });

      expect(handle.tools).toEqual(["greet", "add"]);
      expect(mc.registerTool).toHaveBeenCalledTimes(2);
      expect(mc.registerTool.mock.calls[0][0].name).toBe("greet");
      expect(mc.registerTool.mock.calls[1][0].name).toBe("add");

      handle.dispose();
    });

    it("calls onSync with discovered MCP tools", async () => {
      mockModelContext();
      const onSync = vi.fn();

      setupFetchMock([
        () =>
          mockSseResponse(
            jsonRpcResult(1, {
              protocolVersion: "2024-11-05",
              capabilities: {},
              serverInfo: { name: "test", version: "1.0" }
            })
          ),
        () => mockJsonResponse(""),
        () => mockSseResponse(jsonRpcResult(2, TOOLS_LIST_RESULT))
      ]);

      const handle = await registerWebMcp({
        url: "/mcp",
        watch: false,
        onSync
      });

      expect(onSync).toHaveBeenCalledTimes(1);
      expect(onSync.mock.calls[0][0]).toHaveLength(2);
      expect(onSync.mock.calls[0][0][0].name).toBe("greet");

      handle.dispose();
    });

    it("calls onError when initialization fails", async () => {
      mockModelContext();
      const onError = vi.fn();

      globalThis.fetch = vi.fn(async () => {
        throw new Error("Network failure");
      }) as unknown as typeof fetch;

      const handle = await registerWebMcp({
        url: "/mcp",
        watch: false,
        onError
      });

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0].message).toBe("Network failure");
      expect(handle.tools).toEqual([]);

      handle.dispose();
    });

    it("dispose unregisters all tools from modelContext", async () => {
      const mc = mockModelContext();

      setupFetchMock([
        () =>
          mockSseResponse(
            jsonRpcResult(1, {
              protocolVersion: "2024-11-05",
              capabilities: {},
              serverInfo: { name: "test", version: "1.0" }
            })
          ),
        () => mockJsonResponse(""),
        () => mockSseResponse(jsonRpcResult(2, TOOLS_LIST_RESULT))
      ]);

      const handle = await registerWebMcp({
        url: "/mcp",
        watch: false
      });

      expect(handle.tools).toHaveLength(2);

      handle.dispose();

      expect(mc.unregisterTool).toHaveBeenCalledWith("greet");
      expect(mc.unregisterTool).toHaveBeenCalledWith("add");
      expect(handle.tools).toEqual([]);
    });

    it("sends correct JSON-RPC requests", async () => {
      mockModelContext();

      setupFetchMock([
        () =>
          mockSseResponse(
            jsonRpcResult(1, {
              protocolVersion: "2024-11-05",
              capabilities: {},
              serverInfo: { name: "test", version: "1.0" }
            })
          ),
        () => mockJsonResponse(""),
        () => mockSseResponse(jsonRpcResult(2, TOOLS_LIST_RESULT))
      ]);

      const handle = await registerWebMcp({
        url: "/mcp",
        watch: false
      });

      // First call: initialize
      expect(fetchRequests[0].body.method).toBe("initialize");
      expect(fetchRequests[0].body.jsonrpc).toBe("2.0");
      const initParams = fetchRequests[0].body.params as Record<
        string,
        Record<string, unknown>
      >;
      expect(initParams.clientInfo.name).toBe("webmcp-adapter");

      // Second call: notifications/initialized
      expect(fetchRequests[1].body.method).toBe("notifications/initialized");

      // Third call: tools/list
      expect(fetchRequests[2].body.method).toBe("tools/list");

      // Session ID should be forwarded after first response
      expect(fetchRequests[1].headers["mcp-session-id"]).toBe("test-session");
      expect(fetchRequests[2].headers["mcp-session-id"]).toBe("test-session");

      handle.dispose();
    });

    it("resolves relative URLs against location.origin", async () => {
      mockModelContext();

      setupFetchMock([
        () =>
          mockSseResponse(
            jsonRpcResult(1, {
              protocolVersion: "2024-11-05",
              capabilities: {},
              serverInfo: { name: "test", version: "1.0" }
            })
          ),
        () => mockJsonResponse(""),
        () => mockSseResponse(jsonRpcResult(2, { tools: [] }))
      ]);

      const handle = await registerWebMcp({
        url: "/mcp",
        watch: false
      });

      expect(fetchRequests[0].url).toBe("http://localhost:3000/mcp");

      handle.dispose();
    });

    it("includes custom headers in every request", async () => {
      mockModelContext();

      setupFetchMock([
        () =>
          mockSseResponse(
            jsonRpcResult(1, {
              protocolVersion: "2024-11-05",
              capabilities: {},
              serverInfo: { name: "test", version: "1.0" }
            })
          ),
        () => mockJsonResponse(""),
        () => mockSseResponse(jsonRpcResult(2, { tools: [] }))
      ]);

      const handle = await registerWebMcp({
        url: "/mcp",
        headers: { Authorization: "Bearer test-token" },
        watch: false
      });

      // All three requests should carry the custom header
      for (const req of fetchRequests) {
        expect(req.headers.Authorization).toBe("Bearer test-token");
      }

      handle.dispose();
    });

    it("calls getHeaders before each request for dynamic tokens", async () => {
      mockModelContext();
      let callCount = 0;

      setupFetchMock([
        () =>
          mockSseResponse(
            jsonRpcResult(1, {
              protocolVersion: "2024-11-05",
              capabilities: {},
              serverInfo: { name: "test", version: "1.0" }
            })
          ),
        () => mockJsonResponse(""),
        () => mockSseResponse(jsonRpcResult(2, { tools: [] }))
      ]);

      const handle = await registerWebMcp({
        url: "/mcp",
        getHeaders: async () => {
          callCount++;
          return { Authorization: `Bearer token-${callCount}` };
        },
        watch: false
      });

      // getHeaders called once per request (3 total: init, notify, tools/list)
      expect(callCount).toBe(3);
      expect(fetchRequests[0].headers.Authorization).toBe("Bearer token-1");
      expect(fetchRequests[1].headers.Authorization).toBe("Bearer token-2");
      expect(fetchRequests[2].headers.Authorization).toBe("Bearer token-3");

      handle.dispose();
    });

    it("merges headers and getHeaders with getHeaders taking precedence", async () => {
      mockModelContext();

      setupFetchMock([
        () =>
          mockSseResponse(
            jsonRpcResult(1, {
              protocolVersion: "2024-11-05",
              capabilities: {},
              serverInfo: { name: "test", version: "1.0" }
            })
          ),
        () => mockJsonResponse(""),
        () => mockSseResponse(jsonRpcResult(2, { tools: [] }))
      ]);

      const handle = await registerWebMcp({
        url: "/mcp",
        headers: {
          Authorization: "Bearer static",
          "X-Custom": "from-headers"
        },
        getHeaders: async () => ({
          Authorization: "Bearer dynamic"
        }),
        watch: false
      });

      // getHeaders overrides static Authorization, X-Custom preserved
      for (const req of fetchRequests) {
        expect(req.headers.Authorization).toBe("Bearer dynamic");
        expect(req.headers["X-Custom"]).toBe("from-headers");
      }

      handle.dispose();
    });

    it("registers tools with correct schema and description", async () => {
      const mc = mockModelContext();

      setupFetchMock([
        () =>
          mockSseResponse(
            jsonRpcResult(1, {
              protocolVersion: "2024-11-05",
              capabilities: {},
              serverInfo: { name: "test", version: "1.0" }
            })
          ),
        () => mockJsonResponse(""),
        () => mockSseResponse(jsonRpcResult(2, TOOLS_LIST_RESULT))
      ]);

      const handle = await registerWebMcp({
        url: "/mcp",
        watch: false
      });

      const greetCall = mc.registerTool.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(greetCall.name).toBe("greet");
      expect(greetCall.description).toBe("Greet someone");
      expect(greetCall.inputSchema).toEqual({
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"]
      });
      expect(typeof greetCall.execute).toBe("function");

      handle.dispose();
    });
  });
});
