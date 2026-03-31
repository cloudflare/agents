import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { registerWebMcp } from "../experimental/webmcp";

// ── Helpers ──────────────────────────────────────────────────────────

function jsonRpcResult(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function jsonRpcError(id: number, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function sseFrame(body: string): string {
  return `event: message\ndata: ${body}\n\n`;
}

function mockSseResponse(body: string, sessionId = "test-session"): Response {
  return new Response(sseFrame(body), {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "mcp-session-id": sessionId
    }
  });
}

function mock202Response(sessionId = "test-session"): Response {
  return new Response(null, {
    status: 202,
    headers: { "mcp-session-id": sessionId }
  });
}

const INIT_RESULT = {
  protocolVersion: "2025-11-25",
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name: "test", version: "1.0" }
};

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

function makeSSEStream(): {
  response: Response;
  push: (data: string) => void;
  close: () => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    }
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    }),
    push(data: string) {
      controller.enqueue(encoder.encode(`event: message\ndata: ${data}\n\n`));
    },
    close() {
      controller.close();
    }
  };
}

interface FetchEntry {
  url: string;
  method: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  signal?: AbortSignal | null;
}

let postCallIndex: number;
let postResponses: Array<() => Response>;
let getResponseFn: (() => Response) | undefined;
let fetchRequests: FetchEntry[];

function headersToRecord(raw: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  if (raw instanceof Headers) {
    raw.forEach((v, k) => {
      out[k] = v;
    });
  } else if (Array.isArray(raw)) {
    for (const [k, v] of raw) out[k] = v;
  } else {
    Object.assign(out, raw);
  }
  return out;
}

function setupFetchMock(
  responses: Array<() => Response>,
  sseGetResponse?: () => Response
) {
  postCallIndex = 0;
  postResponses = [...responses];
  getResponseFn = sseGetResponse;
  fetchRequests = [];

  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const method = init?.method ?? "GET";
      const body = init?.body
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : {};
      const headers = headersToRecord(init?.headers);
      fetchRequests.push({ url, method, body, headers, signal: init?.signal });

      if (method === "GET") {
        if (getResponseFn) return getResponseFn();
        return makeSSEStream().response;
      }

      if (method === "DELETE") {
        return new Response(null, { status: 202 });
      }

      if (postCallIndex >= postResponses.length) {
        throw new Error(
          `Unexpected POST #${postCallIndex}: ${body.method ?? "unknown"}`
        );
      }
      return postResponses[postCallIndex++]();
    }
  ) as unknown as typeof fetch;
}

function addPostResponse(fn: () => Response) {
  postResponses.push(fn);
}

function initResponses(
  toolsResult: unknown = TOOLS_LIST_RESULT
): Array<() => Response> {
  return [
    () => mockSseResponse(jsonRpcResult(0, INIT_RESULT)),
    () => mock202Response(),
    () => mockSseResponse(jsonRpcResult(1, toolsResult))
  ];
}

interface SetupResult {
  handle: Awaited<ReturnType<typeof registerWebMcp>>;
  mc: ReturnType<typeof mockModelContext>;
}

async function setupConnected(
  options?: Parameters<typeof registerWebMcp>[0],
  toolsResult?: unknown
): Promise<SetupResult> {
  const mc = mockModelContext();
  setupFetchMock(initResponses(toolsResult));
  const handle = await registerWebMcp({
    url: "/mcp",
    watch: false,
    ...options
  });
  return { handle, mc };
}

function getRegisteredExecute(
  mc: ReturnType<typeof mockModelContext>,
  index: number
): (input: Record<string, unknown>) => Promise<unknown> {
  return (
    mc.registerTool.mock.calls[index][0] as unknown as {
      execute: (input: Record<string, unknown>) => Promise<unknown>;
    }
  ).execute;
}

function postRequests(): FetchEntry[] {
  return fetchRequests.filter((r) => r.method === "POST");
}

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

// ── Global setup ─────────────────────────────────────────────────────

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
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
      const { handle, mc } = await setupConnected();

      expect(handle.tools).toEqual(["greet", "add"]);
      expect(mc.registerTool).toHaveBeenCalledTimes(2);
      expect(mc.registerTool.mock.calls[0][0].name).toBe("greet");
      expect(mc.registerTool.mock.calls[1][0].name).toBe("add");

      handle.dispose();
    });

    it("calls onSync with discovered MCP tools", async () => {
      const onSync = vi.fn();
      const { handle } = await setupConnected({ url: "/mcp", onSync });

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

      await expect(
        registerWebMcp({
          url: "/mcp",
          watch: false,
          onError
        })
      ).rejects.toThrow("Network failure");

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0].message).toContain("Network failure");
    });

    it("dispose unregisters all tools from modelContext", async () => {
      const { handle, mc } = await setupConnected();

      expect(handle.tools).toHaveLength(2);

      handle.dispose();

      expect(mc.unregisterTool).toHaveBeenCalledWith("greet");
      expect(mc.unregisterTool).toHaveBeenCalledWith("add");
      expect(handle.tools).toEqual([]);
    });

    it("sends correct JSON-RPC requests", async () => {
      const { handle } = await setupConnected();
      const posts = postRequests();

      expect(posts[0].body.method).toBe("initialize");
      expect(posts[0].body.jsonrpc).toBe("2.0");

      expect(posts[1].body.method).toBe("notifications/initialized");

      expect(posts[2].body.method).toBe("tools/list");

      expect(posts[1].headers["mcp-session-id"]).toBe("test-session");
      expect(posts[2].headers["mcp-session-id"]).toBe("test-session");

      handle.dispose();
    });

    it("resolves relative URLs against location.origin", async () => {
      const { handle } = await setupConnected();

      expect(postRequests()[0].url).toBe(`${location.origin}/mcp`);

      handle.dispose();
    });

    it("includes custom headers in every request", async () => {
      const { handle } = await setupConnected({
        url: "/mcp",
        headers: { Authorization: "Bearer test-token" }
      });

      for (const req of postRequests()) {
        expect(
          req.headers["authorization"] ?? req.headers["Authorization"]
        ).toBe("Bearer test-token");
      }

      handle.dispose();
    });

    it("calls getHeaders for dynamic tokens", async () => {
      let callCount = 0;
      const { handle } = await setupConnected({
        url: "/mcp",
        getHeaders: async () => {
          callCount++;
          return { "X-Dynamic": `token-${callCount}` };
        }
      });

      expect(callCount).toBeGreaterThanOrEqual(1);
      const firstPost = postRequests()[0];
      expect(
        firstPost.headers["x-dynamic"] ?? firstPost.headers["X-Dynamic"]
      ).toMatch(/^token-/);

      handle.dispose();
    });

    it("merges headers and getHeaders with getHeaders taking precedence", async () => {
      const { handle } = await setupConnected({
        url: "/mcp",
        headers: {
          Authorization: "Bearer static",
          "X-Custom": "from-headers"
        },
        getHeaders: async () => ({
          Authorization: "Bearer dynamic"
        })
      });

      for (const req of postRequests()) {
        const auth =
          req.headers["authorization"] ?? req.headers["Authorization"];
        expect(auth).toBe("Bearer dynamic");
      }

      handle.dispose();
    });

    it("registers tools with correct schema and description", async () => {
      const { handle, mc } = await setupConnected();

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

  // ── Tool execution ────────────────────────────────────────────────

  describe("tool execution", () => {
    it("relays execute() to MCP server via tools/call", async () => {
      const { handle, mc } = await setupConnected();

      addPostResponse(() =>
        mockSseResponse(
          jsonRpcResult(2, {
            content: [{ type: "text", text: "Hello, World!" }]
          })
        )
      );

      const execute = getRegisteredExecute(mc, 0);
      const result = await execute({ name: "World" });

      expect(result).toBe("Hello, World!");

      const callReq = postRequests().find(
        (r) => r.body.method === "tools/call"
      );
      expect(callReq).toBeDefined();
      expect((callReq!.body.params as Record<string, unknown>).name).toBe(
        "greet"
      );

      handle.dispose();
    });

    it("joins multiple text content items with newlines", async () => {
      const { handle, mc } = await setupConnected();

      addPostResponse(() =>
        mockSseResponse(
          jsonRpcResult(2, {
            content: [
              { type: "text", text: "line one" },
              { type: "text", text: "line two" }
            ]
          })
        )
      );

      const execute = getRegisteredExecute(mc, 0);
      const result = await execute({});

      expect(result).toBe("line one\nline two");

      handle.dispose();
    });

    it("throws on isError: true", async () => {
      const { handle, mc } = await setupConnected();

      addPostResponse(() =>
        mockSseResponse(
          jsonRpcResult(2, {
            content: [{ type: "text", text: "something broke" }],
            isError: true
          })
        )
      );

      const execute = getRegisteredExecute(mc, 0);
      await expect(execute({})).rejects.toThrow("something broke");

      handle.dispose();
    });

    it("throws on JSON-RPC error from server", async () => {
      const { handle, mc } = await setupConnected();

      addPostResponse(() =>
        mockSseResponse(jsonRpcError(2, -32600, "Invalid params"))
      );

      const execute = getRegisteredExecute(mc, 0);
      await expect(execute({})).rejects.toThrow();

      handle.dispose();
    });

    it("returns empty string for empty content array", async () => {
      const { handle, mc } = await setupConnected();

      addPostResponse(() => mockSseResponse(jsonRpcResult(2, { content: [] })));

      const execute = getRegisteredExecute(mc, 0);
      const result = await execute({});

      expect(result).toBe("");

      handle.dispose();
    });
  });

  // ── Watch mode / SSE listener ─────────────────────────────────────

  describe("watch mode", () => {
    it("re-syncs tools when tools/list_changed notification arrives", async () => {
      const mc = mockModelContext();
      const sseStream = makeSSEStream();

      const updatedTools = {
        tools: [
          {
            name: "new_tool",
            description: "A new tool",
            inputSchema: { type: "object" }
          }
        ]
      };

      setupFetchMock(initResponses(), () => sseStream.response);

      const onSync = vi.fn();
      const handle = await registerWebMcp({
        url: "/mcp",
        watch: true,
        onSync
      });

      expect(onSync).toHaveBeenCalledTimes(1);
      expect(handle.tools).toEqual(["greet", "add"]);

      addPostResponse(() => mockSseResponse(jsonRpcResult(2, updatedTools)));
      addPostResponse(() => mockSseResponse(jsonRpcResult(3, updatedTools)));

      await new Promise((r) => setTimeout(r, 500));

      sseStream.push(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed"
        })
      );

      await vi.waitFor(
        () => {
          expect(onSync).toHaveBeenCalledTimes(2);
        },
        { timeout: 10000 }
      );

      expect(mc.unregisterTool).toHaveBeenCalledWith("greet");
      expect(mc.unregisterTool).toHaveBeenCalledWith("add");
      expect(handle.tools).toEqual(["new_tool"]);

      sseStream.close();
      handle.dispose();
    });
  });

  // ── Error handling ────────────────────────────────────────────────

  describe("error handling", () => {
    it("calls onError when initialize returns JSON-RPC error", async () => {
      mockModelContext();
      const onError = vi.fn();

      setupFetchMock([
        () => mockSseResponse(jsonRpcError(0, -32600, "Bad request"))
      ]);

      await expect(
        registerWebMcp({
          url: "/mcp",
          watch: false,
          onError
        })
      ).rejects.toThrow();

      expect(onError).toHaveBeenCalledTimes(1);
    });

    it("skips tool when registerTool throws, continues with others", async () => {
      const mc = mockModelContext();
      let callCount = 0;
      mc.registerTool.mockImplementation((tool: { name: string }) => {
        callCount++;
        if (callCount === 1) {
          throw new Error("Registration rejected");
        }
        mc._registeredTools.set(tool.name, tool);
      });

      setupFetchMock(initResponses());

      const handle = await registerWebMcp({
        url: "/mcp",
        watch: false
      });

      expect(handle.tools).toEqual(["add"]);
      expect(mc.registerTool).toHaveBeenCalledTimes(2);

      handle.dispose();
    });
  });

  // ── Edge cases & refresh ──────────────────────────────────────────

  describe("edge cases", () => {
    it("uses tool name as description fallback when description is missing", async () => {
      const { handle, mc } = await setupConnected(undefined, {
        tools: [{ name: "bare_tool", inputSchema: { type: "object" } }]
      });

      const registered = mc.registerTool.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(registered.description).toBe("bare_tool");

      handle.dispose();
    });

    it("passes through annotations.readOnlyHint", async () => {
      const { handle, mc } = await setupConnected(undefined, {
        tools: [
          {
            name: "reader",
            description: "Read-only tool",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true }
          }
        ]
      });

      const registered = mc.registerTool.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(registered.annotations).toEqual({ readOnlyHint: true });

      handle.dispose();
    });

    it("handles empty tools list from server", async () => {
      const onSync = vi.fn();
      const { handle, mc } = await setupConnected(
        { url: "/mcp", onSync },
        { tools: [] }
      );

      expect(handle.tools).toEqual([]);
      expect(mc.registerTool).not.toHaveBeenCalled();
      expect(onSync).toHaveBeenCalledTimes(1);
      expect(onSync.mock.calls[0][0]).toEqual([]);

      handle.dispose();
    });

    it("continues without watch when server returns 405 on GET", async () => {
      mockModelContext();

      setupFetchMock(
        initResponses(),
        () =>
          new Response("Method Not Allowed", {
            status: 405,
            headers: { "content-type": "text/plain" }
          })
      );

      const onError = vi.fn();
      const handle = await registerWebMcp({
        url: "/mcp",
        watch: true,
        onError
      });

      expect(handle.tools).toEqual(["greet", "add"]);

      handle.dispose();
    });

    it("refresh re-fetches and re-registers tools", async () => {
      const { handle, mc } = await setupConnected();

      expect(handle.tools).toEqual(["greet", "add"]);

      const updatedTools = {
        tools: [
          {
            name: "alpha",
            description: "First",
            inputSchema: { type: "object" }
          },
          {
            name: "beta",
            description: "Second",
            inputSchema: { type: "object" }
          },
          {
            name: "gamma",
            description: "Third",
            inputSchema: { type: "object" }
          }
        ]
      };
      addPostResponse(() => mockSseResponse(jsonRpcResult(2, updatedTools)));

      await handle.refresh();

      expect(mc.unregisterTool).toHaveBeenCalledWith("greet");
      expect(mc.unregisterTool).toHaveBeenCalledWith("add");
      expect(handle.tools).toEqual(["alpha", "beta", "gamma"]);

      handle.dispose();
    });
  });

  // ── Known bugs (tests document expected behavior that currently fails) ──

  describe("known bugs", () => {
    it("reports HTTP error status via onError instead of parse failure", async () => {
      mockModelContext();
      const onError = vi.fn();

      setupFetchMock([
        () =>
          new Response("Internal Server Error", {
            status: 500,
            headers: { "content-type": "text/plain" }
          })
      ]);

      await expect(
        registerWebMcp({
          url: "/mcp",
          watch: false,
          onError
        })
      ).rejects.toThrow(/500|Internal Server Error/);

      expect(onError).toHaveBeenCalledTimes(1);
      const error = onError.mock.calls[0][0] as Error;
      expect(error.message).toMatch(/500|Internal Server Error/);
    });

    it("fetches all pages when server returns nextCursor", async () => {
      mockModelContext();

      const page1 = {
        tools: [
          { name: "tool_a", description: "A", inputSchema: { type: "object" } }
        ],
        nextCursor: "cursor-page2"
      };
      const page2 = {
        tools: [
          { name: "tool_b", description: "B", inputSchema: { type: "object" } }
        ]
      };

      setupFetchMock([
        () => mockSseResponse(jsonRpcResult(0, INIT_RESULT)),
        () => mock202Response(),
        () => mockSseResponse(jsonRpcResult(1, page1)),
        () => mockSseResponse(jsonRpcResult(2, page2))
      ]);

      const handle = await registerWebMcp({
        url: "/mcp",
        watch: false
      });

      expect(handle.tools).toEqual(["tool_a", "tool_b"]);

      handle.dispose();
    });

    it("returns structured content for non-text tool results", async () => {
      const { handle, mc } = await setupConnected();

      addPostResponse(() =>
        mockSseResponse(
          jsonRpcResult(2, {
            content: [
              {
                type: "image",
                data: "iVBORw0KGgoAAAANSUhEUg==",
                mimeType: "image/png"
              },
              { type: "text", text: "caption" }
            ]
          })
        )
      );

      const execute = getRegisteredExecute(mc, 0);
      const result = await execute({});

      expect(result).not.toBe("caption");
      expect(result).not.toBe("\ncaption");
      expect(result).toEqual(
        expect.stringContaining("iVBORw0KGgoAAAANSUhEUg==")
      );

      handle.dispose();
    });
  });
});
