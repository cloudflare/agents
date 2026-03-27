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
  return `data: ${body}\n\n`;
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

function mockJsonResponse(body: string, sessionId = "test-session"): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "mcp-session-id": sessionId
    }
  });
}

const INIT_RESULT = {
  protocolVersion: "2024-11-05",
  capabilities: {},
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

let fetchCallIndex: number;
let fetchResponses: Array<() => Response>;
let fetchRequests: Array<{
  url: string;
  method: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  signal?: AbortSignal | null;
}>;

function setupFetchMock(responses: Array<() => Response>) {
  fetchCallIndex = 0;
  fetchResponses = responses;
  fetchRequests = [];

  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const body = init?.body
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : {};
      const headers = (init?.headers ?? {}) as Record<string, string>;
      fetchRequests.push({ url, method, body, headers, signal: init?.signal });

      if (fetchCallIndex >= fetchResponses.length) {
        throw new Error(`Unexpected fetch call #${fetchCallIndex}`);
      }
      return fetchResponses[fetchCallIndex++]();
    }
  ) as unknown as typeof fetch;
}

function initResponses(
  toolsResult: unknown = TOOLS_LIST_RESULT
): Array<() => Response> {
  return [
    () => mockSseResponse(jsonRpcResult(1, INIT_RESULT)),
    () => mockJsonResponse(""),
    () => mockSseResponse(jsonRpcResult(2, toolsResult))
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
      controller.enqueue(encoder.encode(`data: ${data}\n\n`));
    },
    close() {
      controller.close();
    }
  };
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
      const { handle, mc } = await setupConnected();

      expect(handle.tools).toHaveLength(2);

      handle.dispose();

      expect(mc.unregisterTool).toHaveBeenCalledWith("greet");
      expect(mc.unregisterTool).toHaveBeenCalledWith("add");
      expect(handle.tools).toEqual([]);
    });

    it("sends correct JSON-RPC requests", async () => {
      const { handle } = await setupConnected();

      expect(fetchRequests[0].body.method).toBe("initialize");
      expect(fetchRequests[0].body.jsonrpc).toBe("2.0");
      const initParams = fetchRequests[0].body.params as Record<
        string,
        Record<string, unknown>
      >;
      expect(initParams.clientInfo.name).toBe("webmcp-adapter");

      expect(fetchRequests[1].body.method).toBe("notifications/initialized");

      expect(fetchRequests[2].body.method).toBe("tools/list");

      expect(fetchRequests[1].headers["mcp-session-id"]).toBe("test-session");
      expect(fetchRequests[2].headers["mcp-session-id"]).toBe("test-session");

      handle.dispose();
    });

    it("resolves relative URLs against location.origin", async () => {
      const { handle } = await setupConnected();

      expect(fetchRequests[0].url).toBe(`${location.origin}/mcp`);

      handle.dispose();
    });

    it("includes custom headers in every request", async () => {
      const { handle } = await setupConnected({
        url: "/mcp",
        headers: { Authorization: "Bearer test-token" }
      });

      for (const req of fetchRequests) {
        expect(req.headers.Authorization).toBe("Bearer test-token");
      }

      handle.dispose();
    });

    it("calls getHeaders before each request for dynamic tokens", async () => {
      let callCount = 0;
      const { handle } = await setupConnected({
        url: "/mcp",
        getHeaders: async () => {
          callCount++;
          return { Authorization: `Bearer token-${callCount}` };
        }
      });

      expect(callCount).toBe(3);
      expect(fetchRequests[0].headers.Authorization).toBe("Bearer token-1");
      expect(fetchRequests[1].headers.Authorization).toBe("Bearer token-2");
      expect(fetchRequests[2].headers.Authorization).toBe("Bearer token-3");

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

      for (const req of fetchRequests) {
        expect(req.headers.Authorization).toBe("Bearer dynamic");
        expect(req.headers["X-Custom"]).toBe("from-headers");
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

  // ── Phase 2: Tool execution ──────────────────────────────────────

  describe("tool execution", () => {
    it("relays execute() to MCP server via tools/call", async () => {
      const { handle, mc } = await setupConnected();

      const toolCallResult = {
        content: [{ type: "text", text: "Hello, World!" }]
      };
      fetchResponses.push(() =>
        mockSseResponse(jsonRpcResult(3, toolCallResult))
      );

      const execute = getRegisteredExecute(mc, 0);
      const result = await execute({ name: "World" });

      expect(result).toBe("Hello, World!");

      const callReq = fetchRequests[3];
      expect(callReq.body.method).toBe("tools/call");
      expect((callReq.body.params as Record<string, unknown>).name).toBe(
        "greet"
      );
      expect(
        (callReq.body.params as Record<string, unknown>).arguments
      ).toEqual({ name: "World" });

      handle.dispose();
    });

    it("joins multiple text content items with newlines", async () => {
      const { handle, mc } = await setupConnected();

      fetchResponses.push(() =>
        mockSseResponse(
          jsonRpcResult(3, {
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

      fetchResponses.push(() =>
        mockSseResponse(
          jsonRpcResult(3, {
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

      fetchResponses.push(() =>
        mockSseResponse(jsonRpcError(3, -32600, "Invalid params"))
      );

      const execute = getRegisteredExecute(mc, 0);
      await expect(execute({})).rejects.toThrow("Invalid params");

      handle.dispose();
    });

    it("returns empty string for empty content array", async () => {
      const { handle, mc } = await setupConnected();

      fetchResponses.push(() =>
        mockSseResponse(jsonRpcResult(3, { content: [] }))
      );

      const execute = getRegisteredExecute(mc, 0);
      const result = await execute({});

      expect(result).toBe("");

      handle.dispose();
    });
  });

  // ── Phase 3: Watch mode / SSE listener ───────────────────────────

  describe("watch mode", () => {
    it("opens GET SSE stream after init when watch is true", async () => {
      const mc = mockModelContext();
      const sseStream = makeSSEStream();

      setupFetchMock([...initResponses(), () => sseStream.response]);

      const handle = await registerWebMcp({
        url: "/mcp",
        watch: true
      });

      expect(fetchRequests).toHaveLength(4);
      const getReq = fetchRequests[3];
      expect(getReq.method).toBe("GET");
      expect(getReq.headers.Accept).toBe("text/event-stream");
      expect(getReq.headers["mcp-session-id"]).toBe("test-session");

      sseStream.close();
      handle.dispose();
    });

    it("re-syncs tools when tools/list_changed notification arrives", async () => {
      const mc = mockModelContext();
      const sseStream = makeSSEStream();

      const updatedTools = {
        tools: [{ name: "new_tool", description: "A new tool" }]
      };

      setupFetchMock([
        ...initResponses(),
        () => sseStream.response,
        () => mockSseResponse(jsonRpcResult(3, updatedTools))
      ]);

      const onSync = vi.fn();
      const handle = await registerWebMcp({
        url: "/mcp",
        watch: true,
        onSync
      });

      expect(onSync).toHaveBeenCalledTimes(1);
      expect(handle.tools).toEqual(["greet", "add"]);

      sseStream.push(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed"
        })
      );

      await vi.waitFor(() => {
        expect(onSync).toHaveBeenCalledTimes(2);
      });

      expect(mc.unregisterTool).toHaveBeenCalledWith("greet");
      expect(mc.unregisterTool).toHaveBeenCalledWith("add");
      expect(handle.tools).toEqual(["new_tool"]);

      sseStream.close();
      handle.dispose();
    });

    it("dispose aborts the SSE stream", async () => {
      mockModelContext();
      const sseStream = makeSSEStream();

      setupFetchMock([...initResponses(), () => sseStream.response]);

      const handle = await registerWebMcp({
        url: "/mcp",
        watch: true
      });

      const signal = fetchRequests[3].signal;
      expect(signal?.aborted).toBe(false);

      handle.dispose();

      expect(signal?.aborted).toBe(true);

      sseStream.close();
    });

    it("skips SSE listener when no session ID is returned", async () => {
      mockModelContext();

      setupFetchMock([
        () =>
          new Response(sseFrame(jsonRpcResult(1, INIT_RESULT)), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          }),
        () =>
          new Response("", {
            status: 200,
            headers: { "content-type": "application/json" }
          }),
        () =>
          new Response(sseFrame(jsonRpcResult(2, TOOLS_LIST_RESULT)), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
      ]);

      const handle = await registerWebMcp({
        url: "/mcp",
        watch: true
      });

      expect(fetchRequests).toHaveLength(3);

      handle.dispose();
    });
  });

  // ── Phase 4: Error handling ──────────────────────────────────────

  describe("error handling", () => {
    it("calls onError when initialize returns JSON-RPC error", async () => {
      mockModelContext();
      const onError = vi.fn();

      setupFetchMock([
        () => mockSseResponse(jsonRpcError(1, -32600, "Bad request"))
      ]);

      const handle = await registerWebMcp({
        url: "/mcp",
        watch: false,
        onError
      });

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0].message).toContain("Bad request");
      expect(handle.tools).toEqual([]);

      handle.dispose();
    });

    it("calls onError when tools/list returns JSON-RPC error", async () => {
      mockModelContext();
      const onError = vi.fn();

      setupFetchMock([
        () => mockSseResponse(jsonRpcResult(1, INIT_RESULT)),
        () => mockJsonResponse(""),
        () => mockSseResponse(jsonRpcError(2, -32601, "Method not found"))
      ]);

      const handle = await registerWebMcp({
        url: "/mcp",
        watch: false,
        onError
      });

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0].message).toContain("Method not found");

      handle.dispose();
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

    it("calls onError when watch re-sync fails", async () => {
      mockModelContext();
      const sseStream = makeSSEStream();
      const onError = vi.fn();

      setupFetchMock([
        ...initResponses(),
        () => sseStream.response,
        () => {
          throw new Error("Re-sync network failure");
        }
      ]);

      const handle = await registerWebMcp({
        url: "/mcp",
        watch: true,
        onError
      });

      sseStream.push(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed"
        })
      );

      await vi.waitFor(() => {
        expect(onError).toHaveBeenCalledTimes(1);
      });

      expect(onError.mock.calls[0][0].message).toBe("Re-sync network failure");

      sseStream.close();
      handle.dispose();
    });
  });

  // ── Phase 5: Edge cases & refresh ────────────────────────────────

  describe("edge cases", () => {
    it("uses tool name as description fallback when description is missing", async () => {
      const { handle, mc } = await setupConnected(undefined, {
        tools: [{ name: "bare_tool" }]
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

    it("refresh re-fetches and re-registers tools", async () => {
      const { handle, mc } = await setupConnected();

      expect(handle.tools).toEqual(["greet", "add"]);

      const updatedTools = {
        tools: [
          { name: "alpha", description: "First" },
          { name: "beta", description: "Second" },
          { name: "gamma", description: "Third" }
        ]
      };
      fetchResponses.push(() =>
        mockSseResponse(jsonRpcResult(3, updatedTools))
      );

      await handle.refresh();

      expect(mc.unregisterTool).toHaveBeenCalledWith("greet");
      expect(mc.unregisterTool).toHaveBeenCalledWith("add");
      expect(handle.tools).toEqual(["alpha", "beta", "gamma"]);

      handle.dispose();
    });
  });
});
