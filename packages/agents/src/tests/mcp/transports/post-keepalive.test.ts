import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  WorkerTransport,
  type WorkerTransportOptions
} from "../../../mcp/worker-transport";
import { z } from "zod";

/**
 * Tests for keepalive pings on both GET and POST SSE response streams.
 *
 * Both the GET and POST SSE handlers should set up a 30-second keepalive
 * interval that writes "event: ping" to prevent proxies and infrastructure
 * from closing idle connections during long-running operations.
 */
describe("WorkerTransport POST stream keepalive", () => {
  let setIntervalSpy = vi.spyOn(globalThis, "setInterval");

  const createSlowToolServer = () => {
    const server = new McpServer(
      { name: "test-server", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    server.registerTool(
      "slow-tool",
      {
        description: "A tool that simulates a slow backend call",
        inputSchema: { message: z.string().describe("Test message") }
      },
      async ({ message }) => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { content: [{ text: `Done: ${message}`, type: "text" }] };
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

  beforeEach(() => {
    setIntervalSpy = vi.spyOn(globalThis, "setInterval");
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
  });

  it("GET SSE stream should set up a keepalive interval", async () => {
    const server = createSlowToolServer();
    const transport = await setupTransport(server, {
      sessionIdGenerator: () => "test-session-get"
    });

    await initializeSession(transport);
    setIntervalSpy.mockClear();

    const getRequest = new Request("http://localhost/mcp", {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "mcp-session-id": "test-session-get"
      }
    });

    const response = await transport.handleRequest(getRequest);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    const keepaliveCalls = setIntervalSpy.mock.calls.filter(
      (call) => call[1] === 30000
    );
    expect(keepaliveCalls.length).toBeGreaterThanOrEqual(1);

    await server.close();
  });

  it("POST SSE stream should set up a keepalive interval", async () => {
    const server = createSlowToolServer();
    const transport = await setupTransport(server, {
      sessionIdGenerator: () => "test-session-post"
    });

    await initializeSession(transport);
    setIntervalSpy.mockClear();

    const toolRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": "test-session-post"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "slow-tool",
          arguments: { message: "test" }
        }
      })
    });

    const response = await transport.handleRequest(toolRequest);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    const keepaliveCalls = setIntervalSpy.mock.calls.filter(
      (call) => call[1] === 30000
    );
    expect(keepaliveCalls.length).toBeGreaterThanOrEqual(1);

    await server.close();
  });

  it("POST keepalive cleanup should clear the interval", async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const server = createSlowToolServer();
    const transport = await setupTransport(server, {
      sessionIdGenerator: () => "test-session-cleanup"
    });

    await initializeSession(transport);
    setIntervalSpy.mockClear();
    clearIntervalSpy.mockClear();

    const toolRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": "test-session-cleanup"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "slow-tool",
          arguments: { message: "test" }
        }
      })
    });

    const response = await transport.handleRequest(toolRequest);
    expect(response.status).toBe(200);

    // Verify keepalive was set up
    const keepaliveCalls = setIntervalSpy.mock.calls.filter(
      (call) => call[1] === 30000
    );
    expect(keepaliveCalls.length).toBeGreaterThanOrEqual(1);

    // Close the stream and verify the interval is cleaned up
    transport.closeSSEStream(3);

    expect(clearIntervalSpy).toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
    await server.close();
  });
});
