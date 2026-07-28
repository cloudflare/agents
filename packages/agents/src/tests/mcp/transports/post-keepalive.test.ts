import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  EventId,
  EventStore,
  StreamId
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  LATEST_PROTOCOL_VERSION,
  type JSONRPCMessage
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  WorkerTransport,
  type WorkerTransportOptions
} from "../../../mcp/worker-transport";

/**
 * Regression tests for cloudflare/agents#1583 and the SDK v1.30 keepalive
 * delegation. WorkerTransport must not add another timer around the SDK
 * transport. Every SDK-owned SSE stream gets exactly one comment-frame
 * keepalive, and the SDK owns its cleanup.
 */
describe("WorkerTransport SSE keepalive", () => {
  let setIntervalSpy = vi.spyOn(globalThis, "setInterval");

  const createServer = () => {
    const server = new McpServer(
      { name: "test-server", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    server.registerTool(
      "echo",
      {
        description: "An echo tool",
        inputSchema: { message: z.string().describe("Test message") }
      },
      async ({ message }) => {
        return { content: [{ text: `Echo: ${message}`, type: "text" }] };
      }
    );

    return server;
  };

  const createHangingServer = () => {
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = createServer();
    server.registerTool(
      "hang",
      {
        description: "Block until the test releases the tool",
        inputSchema: {}
      },
      async () => {
        await released;
        return { content: [{ type: "text" as const, text: "done" }] };
      }
    );
    return {
      release: () => release?.(),
      server
    };
  };

  const setupTransport = async (
    server: McpServer,
    options?: WorkerTransportOptions
  ) => {
    const transport = new WorkerTransport(options);
    await server.connect(transport);
    return transport;
  };

  const initializeSession = async (transport: WorkerTransport) => {
    const response = await transport.handleRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "keepalive-test", version: "1.0.0" }
          }
        })
      })
    );
    await response.text();
  };

  const longRunningIntervals = () =>
    setIntervalSpy.mock.calls.filter((call) => {
      const ms = call[1] as number | undefined;
      return typeof ms === "number" && ms >= 5_000 && ms <= 120_000;
    });

  const mockEventStore = (): EventStore => ({
    storeEvent: vi.fn(
      async (_streamId: StreamId, _message: JSONRPCMessage) =>
        `evt-${crypto.randomUUID()}`
    ),
    replayEventsAfter: vi.fn(async () => "_GET_stream" as StreamId),
    getStreamIdForEventId: vi.fn(async (id: EventId) => id.split(":")[0])
  });

  const getRequest = (sessionId: string) =>
    new Request("http://localhost/mcp", {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "mcp-session-id": sessionId
      }
    });

  const hangingPostRequest = (sessionId: string) =>
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "hang", arguments: {} }
      })
    });

  beforeEach(() => {
    setIntervalSpy = vi.spyOn(globalThis, "setInterval");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "delegates one GET keepalive to SDK v1.30 (eventStore=%s)",
    async (withEventStore) => {
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
      const sessionId = `get-${withEventStore}`;
      const server = createServer();
      const transport = await setupTransport(server, {
        sessionIdGenerator: () => sessionId,
        ...(withEventStore && { eventStore: mockEventStore() })
      });
      await initializeSession(transport);
      setIntervalSpy.mockClear();
      clearIntervalSpy.mockClear();

      const response = await transport.handleRequest(getRequest(sessionId));
      expect(response.status).toBe(200);

      const intervals = longRunningIntervals();
      expect(intervals).toHaveLength(1);
      expect(intervals[0]?.[1]).toBe(15_000);
      const timer = setIntervalSpy.mock.results.at(-1)?.value;

      await transport.close();
      expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    }
  );

  it.each([false, true])(
    "delegates one POST keepalive to SDK v1.30 (eventStore=%s)",
    async (withEventStore) => {
      const sessionId = `post-${withEventStore}`;
      const { release, server } = createHangingServer();
      const transport = await setupTransport(server, {
        sessionIdGenerator: () => sessionId,
        ...(withEventStore && { eventStore: mockEventStore() })
      });
      await initializeSession(transport);
      setIntervalSpy.mockClear();

      const response = await transport.handleRequest(
        hangingPostRequest(sessionId)
      );
      expect(response.status).toBe(200);

      const intervals = longRunningIntervals();
      expect(intervals).toHaveLength(1);
      expect(intervals[0]?.[1]).toBe(15_000);

      const body = response.text();
      release();
      await body;
      await server.close();
    }
  );

  it("forwards keepAliveMs to the SDK transport", async () => {
    const server = createServer();
    const transport = await setupTransport(server, {
      keepAliveMs: 7_000,
      sessionIdGenerator: () => "custom-cadence"
    });
    await initializeSession(transport);
    setIntervalSpy.mockClear();

    const response = await transport.handleRequest(
      getRequest("custom-cadence")
    );
    expect(response.status).toBe(200);
    expect(longRunningIntervals()).toHaveLength(1);
    expect(longRunningIntervals()[0]?.[1]).toBe(7_000);

    await server.close();
  });

  it("allows SDK keepalives to be disabled", async () => {
    const server = createServer();
    const transport = await setupTransport(server, {
      keepAliveMs: 0,
      sessionIdGenerator: () => "disabled"
    });
    await initializeSession(transport);
    setIntervalSpy.mockClear();

    const response = await transport.handleRequest(getRequest("disabled"));
    expect(response.status).toBe(200);
    expect(longRunningIntervals()).toEqual([]);

    await server.close();
  });

  it("streams SDK comment-frame keepalives instead of named events", async () => {
    const { release, server } = createHangingServer();
    const transport = await setupTransport(server, {
      sessionIdGenerator: () => "frame-session"
    });
    await initializeSession(transport);

    vi.useFakeTimers();
    try {
      const response = await transport.handleRequest(
        hangingPostRequest("frame-session")
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Expected an SSE response body");
      const decoder = new TextDecoder();
      let buffered = "";
      const drain = (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
        }
      })();

      await vi.advanceTimersByTimeAsync(16_000);
      release();
      await drain;

      expect(buffered).toContain(": keepalive\n\n");
      expect(buffered).not.toContain("event: ping");
      await server.close();
    } finally {
      release();
      vi.useRealTimers();
    }
  });
});
