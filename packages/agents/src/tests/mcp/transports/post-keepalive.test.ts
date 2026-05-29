import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type {
  EventStore,
  StreamId,
  EventId
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  WorkerTransport,
  type WorkerTransportOptions
} from "../../../mcp/worker-transport";
import { z } from "zod";

/**
 * Regression tests for cloudflare/agents#1583 (WorkerTransport keepalive).
 *
 * The previous implementation had three defects in its SSE keepalive:
 *
 *   1. Frame was `event: ping\ndata: \n\n` \u2014 a named SSE event that
 *      dispatched a `MessageEvent` with type "ping" and empty data,
 *      firing any `addEventListener("ping", …)` on the client. The spec
 *      keepalive is the comment frame `: …\n\n`, dropped by the parser.
 *   2. The interval period was 30s, exactly on the Workers ~30s
 *      post-handler background-work cancellation boundary — no safety
 *      margin if anything delayed a tick.
 *
 * The new behaviour:
 *
 *   - GET (standalone SSE listen stream): keepalive depends on whether
 *     the caller opted into resumability via `eventStore`. With one,
 *     no keepalive (idle drops are recovered by reconnect). Without
 *     one, 25s comment-frame keepalive (no recovery path, preserve
 *     pre-fix behaviour).
 *   - POST (tool response stream): always keepalive. The in-progress
 *     tool call has no recovery path other than staying connected, so
 *     we write `: keepalive\n\n` every 25s so long-running tool calls
 *     survive the ~5min Cloudflare edge idle watchdog.
 */
describe("WorkerTransport SSE keepalive (issue #1583)", () => {
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

  const setupTransport = async (
    server: McpServer,
    options?: WorkerTransportOptions
  ) => {
    const transport = new WorkerTransport(options);
    await server.connect(transport);
    return transport;
  };

  const initializeSession = async (transport: WorkerTransport) => {
    const initRequest = new Request("http://localhost/mcp", {
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
    });

    const initResponse = await transport.handleRequest(initRequest);
    if (initResponse.body) {
      const reader = initResponse.body.getReader();
      while (!(await reader.read()).done) {}
    }
  };

  const longRunningIntervals = () =>
    setIntervalSpy.mock.calls.filter((call) => {
      const ms = call[1] as number | undefined;
      return typeof ms === "number" && ms >= 5_000 && ms <= 120_000;
    });

  /** Minimal mock {@link EventStore} so we can test the "no keepalive" path. */
  const mockEventStore = (): EventStore => ({
    storeEvent: vi.fn(
      async (_streamId: StreamId, _message: JSONRPCMessage) =>
        `evt-${Math.random().toString(36).slice(2)}`
    ),
    replayEventsAfter: vi.fn(async () => "_GET_stream" as StreamId),
    getStreamIdForEventId: vi.fn(async (id: EventId) => id.split(":")[0])
  });

  beforeEach(() => {
    setIntervalSpy = vi.spyOn(globalThis, "setInterval");
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
  });

  describe("GET stream keepalive depends on eventStore", () => {
    it("arms a 25s interval when no eventStore is configured", async () => {
      const server = createServer();
      const transport = await setupTransport(server, {
        sessionIdGenerator: () => "get-session-no-store"
      });
      await initializeSession(transport);
      setIntervalSpy.mockClear();

      const response = await transport.handleRequest(
        new Request("http://localhost/mcp", {
          method: "GET",
          headers: {
            Accept: "text/event-stream",
            "mcp-session-id": "get-session-no-store"
          }
        })
      );
      expect(response.status).toBe(200);

      const intervals = longRunningIntervals();
      expect(intervals.length).toBeGreaterThanOrEqual(1);
      expect(intervals[0][1]).toBe(25_000);

      await server.close();
    });

    it("skips the keepalive when eventStore is configured", async () => {
      const server = createServer();
      const transport = await setupTransport(server, {
        sessionIdGenerator: () => "get-session-with-store",
        eventStore: mockEventStore()
      });
      await initializeSession(transport);
      setIntervalSpy.mockClear();

      const response = await transport.handleRequest(
        new Request("http://localhost/mcp", {
          method: "GET",
          headers: {
            Accept: "text/event-stream",
            "mcp-session-id": "get-session-with-store"
          }
        })
      );
      expect(response.status).toBe(200);
      expect(longRunningIntervals()).toEqual([]);

      await server.close();
    });
  });

  describe("POST stream always arms a 25s keepalive", () => {
    it("with no eventStore configured", async () => {
      const server = createServer();
      const transport = await setupTransport(server, {
        sessionIdGenerator: () => "post-session"
      });
      await initializeSession(transport);
      setIntervalSpy.mockClear();

      const response = await transport.handleRequest(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "mcp-session-id": "post-session"
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "echo", arguments: { message: "hi" } }
          })
        })
      );
      expect(response.status).toBe(200);

      const intervals = longRunningIntervals();
      expect(intervals.length).toBeGreaterThanOrEqual(1);
      expect(intervals[0][1]).toBe(25_000);

      await server.close();
    });

    it("writes comment-frame keepalives (`: keepalive`), not named events", async () => {
      // Build a server with a tool that hangs on a deferred we control,
      // so the SSE response stream stays open long enough for the
      // keepalive interval to actually fire under fake timers.
      let releaseTool: (() => void) | undefined;
      const toolReleased = new Promise<void>((resolve) => {
        releaseTool = resolve;
      });
      const server = new McpServer(
        { name: "test-server", version: "1.0.0" },
        { capabilities: { tools: {} } }
      );
      server.registerTool(
        "hang",
        {
          description: "Block until the test releases us",
          inputSchema: {}
        },
        async () => {
          await toolReleased;
          return { content: [{ type: "text", text: "done" }] };
        }
      );
      const transport = await setupTransport(server, {
        sessionIdGenerator: () => "frame-session"
      });
      await initializeSession(transport);

      vi.useFakeTimers();
      try {
        // tools/call POST returns an SSE response stream that arms the
        // keepalive. Don't await the response here — the stream stays
        // open until we release the tool.
        const responsePromise = transport.handleRequest(
          new Request("http://localhost/mcp", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              "mcp-session-id": "frame-session"
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: { name: "hang", arguments: {} }
            })
          })
        );
        const response = await responsePromise;

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        const drain = (async () => {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffered += decoder.decode(value, { stream: true });
          }
        })();

        // Force two keepalive ticks.
        await vi.advanceTimersByTimeAsync(51_000);

        // Release the tool so the stream terminates cleanly.
        releaseTool!();
        await drain;

        expect(buffered).toContain(": keepalive\n\n");
        expect(buffered).not.toContain("event: ping");

        await server.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it("with eventStore configured (POST streams can't be resumed)", async () => {
      const server = createServer();
      const transport = await setupTransport(server, {
        sessionIdGenerator: () => "post-with-store",
        eventStore: mockEventStore()
      });
      await initializeSession(transport);
      setIntervalSpy.mockClear();

      const response = await transport.handleRequest(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "mcp-session-id": "post-with-store"
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "echo", arguments: { message: "hi" } }
          })
        })
      );
      expect(response.status).toBe(200);

      const intervals = longRunningIntervals();
      expect(intervals.length).toBeGreaterThanOrEqual(1);
      expect(intervals[0][1]).toBe(25_000);

      await server.close();
    });
  });
});
