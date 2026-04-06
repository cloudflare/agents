import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker";
import { MCPClientManager } from "../../mcp/client";
import type { MCPServerRow } from "../../mcp/client-storage";

type RecordedRequest = {
  method: string;
  url: string;
  sessionId: string | null;
  accept: string | null;
};

function createManagerStorage() {
  const rows = new Map<string, MCPServerRow>();
  const kv = new Map<string, unknown>();

  const exec = <T extends Record<string, SqlStorageValue>>(
    query: string,
    ...values: SqlStorageValue[]
  ) => {
    const results: T[] = [];
    const normalizedQuery = query.replace(/\s+/g, " ").trim();

    if (
      normalizedQuery.startsWith("INSERT OR REPLACE INTO cf_agents_mcp_servers")
    ) {
      const row: MCPServerRow = {
        id: values[0] as string,
        name: values[1] as string,
        server_url: values[2] as string,
        client_id: values[3] as string | null,
        auth_url: values[4] as string | null,
        callback_url: values[5] as string,
        server_options: values[6] as string | null
      };
      rows.set(row.id, row);
    } else if (
      normalizedQuery ===
      "SELECT id, name, server_url, client_id, auth_url, callback_url, server_options FROM cf_agents_mcp_servers"
    ) {
      results.push(...(Array.from(rows.values()) as unknown as T[]));
    } else if (
      normalizedQuery ===
      "SELECT server_options FROM cf_agents_mcp_servers WHERE id = ?"
    ) {
      const row = rows.get(values[0] as string);
      if (row) {
        results.push({
          server_options: row.server_options
        } as unknown as T);
      }
    } else if (
      normalizedQuery ===
      "UPDATE cf_agents_mcp_servers SET auth_url = NULL WHERE id = ?"
    ) {
      const row = rows.get(values[0] as string);
      if (row) {
        row.auth_url = null;
        rows.set(row.id, row);
      }
    } else if (
      normalizedQuery === "DELETE FROM cf_agents_mcp_servers WHERE id = ?"
    ) {
      rows.delete(values[0] as string);
    }

    return results[Symbol.iterator]();
  };

  const storage = {
    sql: { exec },
    get: async <T>(key: string) => kv.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      kv.set(key, value);
    },
    kv: {
      get: <T>(key: string) => kv.get(key) as T | undefined,
      put: (key: string, value: unknown) => {
        kv.set(key, value);
      },
      list: vi.fn(),
      delete: vi.fn()
    }
  } as unknown as DurableObjectStorage;

  return { rows, storage };
}

function createRecordedFetch(): {
  fetch: typeof globalThis.fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];

  const recordedFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({
      method: request.method,
      url: request.url,
      sessionId: request.headers.get("mcp-session-id"),
      accept: request.headers.get("accept")
    });

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
    const { rows, storage } = createManagerStorage();
    const manager = new MCPClientManager("test-client", "1.0.0", {
      storage
    });
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

    const server = rows.get(serverId);
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

    const updatedServer = rows.get(serverId);
    expect(updatedServer?.server_options).not.toBeNull();
    const updatedServerOptions = JSON.parse(
      updatedServer?.server_options ?? "{}"
    );
    expect(updatedServerOptions.transport?.sessionId).toBeUndefined();
  });

  it("terminates every real streamable-http session during closeAllConnections", async () => {
    const { rows, storage } = createManagerStorage();
    const manager = new MCPClientManager("test-client", "1.0.0", {
      storage
    });
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
      const server = rows.get(serverId);
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
      const server = rows.get(serverId);
      expect(server?.server_options).not.toBeNull();
      const serverOptions = JSON.parse(server?.server_options ?? "{}");
      expect(serverOptions.transport?.sessionId).toBeUndefined();
    }
  });

  it("reuses a persisted real session id during restore and discovers tools without reinitializing", async () => {
    const { rows, storage } = createManagerStorage();
    const manager1 = new MCPClientManager("test-client", "1.0.0", {
      storage
    });
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

      const serverBeforeRestore = rows.get(serverId);
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

      manager2 = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
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
