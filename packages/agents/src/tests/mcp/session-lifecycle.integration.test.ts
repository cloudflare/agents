import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker";
import type { MCPClientManager } from "../../mcp/client";
import type { MCPServerRow } from "../../mcp/client/storage";
import { type McpHarness, withMcpHarness } from "../capabilities/mcp-client";

type RecordedRequest = {
  method: string;
  url: string;
  sessionId: string | null;
  accept: string | null;
  body?: string;
};

function getServerRow(
  harness: McpHarness,
  serverId: string
): MCPServerRow | undefined {
  return harness.serverRows().find((row) => row.id === serverId);
}

function createRecordedFetch(options?: { rejectSessionId?: string }): {
  fetch: typeof globalThis.fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];

  const recordedFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const sessionId = request.headers.get("mcp-session-id");
    requests.push({
      method: request.method,
      url: request.url,
      sessionId,
      accept: request.headers.get("accept"),
      body: request.method === "POST" ? await request.clone().text() : undefined
    });

    if (sessionId === options?.rejectSessionId) {
      return new Response("Session not found", { status: 404 });
    }

    const ctx = createExecutionContext();
    return worker.fetch(request, env, ctx);
  };

  return { fetch: recordedFetch, requests };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP streamable-http session lifecycle integration", () => {
  it("persists a real session id, opens the background SSE GET, and sends DELETE on close", async () => {
    await withMcpHarness(async (harness) => {
      const manager = harness.createManager();
      const { fetch, requests } = createRecordedFetch();
      const serverId = "integration-session-close";

      await manager.registerServer(serverId, {
        url: "http://example.com/mcp",
        name: "Integration Session Server",
        callbackUrl: "http://localhost:3000/callback",
        client: {},
        transport: {
          type: "streamable-http",
          fetch
        }
      });

      const connectResult = await manager.connectToServer(serverId);
      expect(connectResult.state).toBe("connected");

      const server = getServerRow(harness, serverId);
      expect(server?.server_options).not.toBeNull();
      const serverOptions = JSON.parse(server?.server_options ?? "{}");
      const persistedSessionId = serverOptions.transport?.sessionId;

      expect(typeof persistedSessionId).toBe("string");
      expect(persistedSessionId).toBeTruthy();

      await vi.waitFor(() => {
        expect(
          requests.some(
            (request) =>
              request.method === "GET" &&
              request.accept === "text/event-stream" &&
              request.sessionId === persistedSessionId
          )
        ).toBe(true);
      });

      await manager.closeConnection(serverId);

      expect(
        requests.some(
          (request) =>
            request.method === "DELETE" &&
            request.sessionId === persistedSessionId
        )
      ).toBe(true);

      const updatedServer = getServerRow(harness, serverId);
      expect(updatedServer?.server_options).not.toBeNull();
      const updatedServerOptions = JSON.parse(
        updatedServer?.server_options ?? "{}"
      );
      expect(updatedServerOptions.transport?.sessionId).toBeUndefined();
    });
  });

  it("terminates every real streamable-http session during closeAllConnections", async () => {
    await withMcpHarness(async (harness) => {
      const manager = harness.createManager();
      const { fetch, requests } = createRecordedFetch();
      const serverIds = ["integration-close-all-1", "integration-close-all-2"];

      for (const serverId of serverIds) {
        await manager.registerServer(serverId, {
          url: "http://example.com/mcp",
          name: serverId,
          callbackUrl: "http://localhost:3000/callback",
          client: {},
          transport: {
            type: "streamable-http",
            fetch
          }
        });

        const connectResult = await manager.connectToServer(serverId);
        expect(connectResult.state).toBe("connected");
      }

      const persistedSessionIds = serverIds.map((serverId) => {
        const server = getServerRow(harness, serverId);
        expect(server?.server_options).not.toBeNull();
        const serverOptions = JSON.parse(server?.server_options ?? "{}");
        expect(typeof serverOptions.transport?.sessionId).toBe("string");
        return serverOptions.transport?.sessionId as string;
      });

      await manager.closeAllConnections();

      for (const sessionId of persistedSessionIds) {
        expect(
          requests.some(
            (request) =>
              request.method === "DELETE" && request.sessionId === sessionId
          )
        ).toBe(true);
      }

      for (const serverId of serverIds) {
        const server = getServerRow(harness, serverId);
        expect(server?.server_options).not.toBeNull();
        const serverOptions = JSON.parse(server?.server_options ?? "{}");
        expect(serverOptions.transport?.sessionId).toBeUndefined();
      }
    });
  });

  it("reuses a persisted real session id during restore and discovers tools without reinitializing", async () => {
    await withMcpHarness(async (harness) => {
      const manager1 = harness.createManager();
      const initialFetch = createRecordedFetch();
      const serverId = "integration-session-restore";
      let manager2: MCPClientManager | undefined;

      try {
        await manager1.registerServer(serverId, {
          url: "http://example.com/mcp",
          name: "Integration Restore Server",
          callbackUrl: "http://localhost:3000/callback",
          client: {},
          transport: {
            type: "streamable-http",
            fetch: initialFetch.fetch
          }
        });

        const initialConnectResult = await manager1.connectToServer(serverId);
        expect(initialConnectResult.state).toBe("connected");

        const serverBeforeRestore = getServerRow(harness, serverId);
        expect(serverBeforeRestore?.server_options).not.toBeNull();
        const serverOptionsBeforeRestore = JSON.parse(
          serverBeforeRestore?.server_options ?? "{}"
        );
        const persistedSessionId =
          serverOptionsBeforeRestore.transport?.sessionId;

        expect(typeof persistedSessionId).toBe("string");
        expect(persistedSessionId).toBeTruthy();

        await manager1.mcpConnections[serverId].client.close();
        delete manager1.mcpConnections[serverId];

        manager2 = harness.createManager();

        const restoredFetch = createRecordedFetch();
        vi.stubGlobal("fetch", restoredFetch.fetch);

        await manager2.restoreConnectionsFromStorage("test-client");
        await manager2.waitForConnections({ timeout: 5000 });

        const restoredConnection = manager2.mcpConnections[serverId];
        expect(restoredConnection).toBeDefined();
        expect(restoredConnection.connectionState).toBe("ready");
        expect(manager2.listTools().some((tool) => tool.name === "greet")).toBe(
          true
        );

        const restoredPostRequests = restoredFetch.requests.filter(
          (request) => request.method === "POST"
        );
        expect(restoredPostRequests.length).toBeGreaterThan(0);
        expect(
          restoredPostRequests.every(
            (request) => request.sessionId === persistedSessionId
          )
        ).toBe(true);
      } finally {
        await manager1.closeAllConnections();
        if (manager2) {
          await manager2.closeAllConnections();
        }
      }
    });
  });

  it("reinitializes when a server rejects a restored session", async () => {
    await withMcpHarness(async (harness) => {
      const staleSessionId = "expired-session";
      const serverId = "integration-stale-session";
      const manager1 = harness.createManager();
      let manager2: MCPClientManager | undefined;

      try {
        await manager1.registerServer(serverId, {
          url: "http://example.com/mcp",
          name: "Stale Session Server",
          transport: {
            type: "streamable-http",
            sessionId: staleSessionId,
            protocolVersion: "2025-11-25"
          }
        });

        manager2 = harness.createManager();

        const restoredFetch = createRecordedFetch({
          rejectSessionId: staleSessionId
        });
        vi.stubGlobal("fetch", restoredFetch.fetch);

        await manager2.restoreConnectionsFromStorage("test-client");
        await manager2.waitForConnections({ timeout: 5000 });

        expect(manager2.mcpConnections[serverId].connectionState).toBe("ready");
        expect(
          restoredFetch.requests.some(
            (request) => request.sessionId === staleSessionId
          )
        ).toBe(true);
        const sessionlessInitializations = restoredFetch.requests.filter(
          (request) =>
            request.method === "POST" &&
            !request.sessionId &&
            request.body &&
            (JSON.parse(request.body) as { method?: string }).method ===
              "initialize"
        );
        expect(sessionlessInitializations).toHaveLength(1);

        const options = JSON.parse(
          getServerRow(harness, serverId)?.server_options ?? "{}"
        );
        expect(options.transport.sessionId).toEqual(expect.any(String));
        expect(options.transport.sessionId).not.toBe(staleSessionId);
      } finally {
        await manager1.closeAllConnections();
        await manager2?.closeAllConnections();
      }
    });
  });
});
