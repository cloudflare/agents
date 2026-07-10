import { env } from "cloudflare:workers";
import type {
  ClientCapabilities,
  ElicitRequest
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { MCPClientManager } from "../../mcp/client";
import { MCPClientConnection } from "../../mcp/client-connection";
import type { MCPServerRow } from "../../mcp/client-storage";

const elicitRequest: ElicitRequest = {
  method: "elicitation/create",
  params: {
    message: "What is your name?",
    requestedSchema: {
      type: "object",
      properties: { name: { type: "string" } }
    }
  }
};

const urlElicitRequest: ElicitRequest = {
  method: "elicitation/create",
  params: {
    mode: "url",
    message: "Connect your account",
    url: "https://example.com/authorize",
    elicitationId: "elicit-1"
  }
};

function advertisedCapabilities(
  connection: MCPClientConnection
): ClientCapabilities {
  return (connection.client as unknown as { _capabilities: ClientCapabilities })
    ._capabilities;
}

describe("MCP client elicitation options (#1875)", () => {
  describe("capability negotiation", () => {
    it("advertises no elicitation capability without a handler", () => {
      const connection = new MCPClientConnection(
        new URL("http://example.com/mcp"),
        { name: "test-client", version: "1.0.0" },
        { transport: { type: "streamable-http" }, client: {} }
      );

      expect(advertisedCapabilities(connection).elicitation).toBeUndefined();
    });

    it("advertises only the modes with configured handlers", () => {
      const connection = new MCPClientConnection(
        new URL("http://example.com/mcp"),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "streamable-http" },
          client: {},
          elicitationHandlers: {
            url: async () => ({ action: "cancel", content: {} })
          }
        }
      );

      expect(advertisedCapabilities(connection).elicitation).toEqual({
        url: {}
      });
    });

    it("lets an explicit declaration narrow the modes despite a handler", () => {
      const connection = new MCPClientConnection(
        new URL("http://example.com/mcp"),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "streamable-http" },
          client: { capabilities: { elicitation: { form: {} } } },
          elicitationHandlers: {
            form: async () => ({ action: "cancel", content: {} }),
            url: async () => ({ action: "cancel", content: {} })
          }
        }
      );

      expect(advertisedCapabilities(connection).elicitation).toEqual({
        form: {}
      });
    });

    it("advertises a seeded capability when no handlers are configured", () => {
      const connection = new MCPClientConnection(
        new URL("http://example.com/mcp"),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "streamable-http" },
          client: {},
          capabilitySeed: { elicitation: { url: {} } }
        }
      );

      expect(advertisedCapabilities(connection).elicitation).toEqual({
        url: {}
      });
    });

    it("configured handlers replace the seed and clearing them un-advertises", () => {
      const connection = new MCPClientConnection(
        new URL("http://example.com/mcp"),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "streamable-http" },
          client: {},
          capabilitySeed: { elicitation: { form: {}, url: {} } }
        }
      );

      connection.configureElicitationHandlers({
        form: async () => ({ action: "accept", content: {} })
      });
      expect(advertisedCapabilities(connection).elicitation).toEqual({
        form: {}
      });

      connection.configureElicitationHandlers(undefined);
      expect(advertisedCapabilities(connection).elicitation).toBeUndefined();
    });

    it("an explicit declaration wins over the seed", () => {
      const connection = new MCPClientConnection(
        new URL("http://example.com/mcp"),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "streamable-http" },
          client: { capabilities: { elicitation: { form: {} } } },
          capabilitySeed: { elicitation: { form: {}, url: {} } }
        }
      );

      expect(advertisedCapabilities(connection).elicitation).toEqual({
        form: {}
      });
    });

    it("honors caller-declared elicitation modes instead of clobbering them", () => {
      const connection = new MCPClientConnection(
        new URL("http://example.com/mcp"),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "streamable-http" },
          client: {
            capabilities: {
              elicitation: { form: {}, url: {} },
              sampling: {}
            }
          }
        }
      );

      const capabilities = advertisedCapabilities(connection);
      expect(capabilities.elicitation).toEqual({ form: {}, url: {} });
      expect(capabilities.sampling).toEqual({});
    });
  });

  describe("elicitation handler injection", () => {
    it("delegates to the injected handler", async () => {
      const handler = vi
        .fn()
        .mockResolvedValue({ action: "accept", content: { name: "Alice" } });
      const connection = new MCPClientConnection(
        new URL("http://example.com/mcp"),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "streamable-http" },
          client: {},
          elicitationHandlers: { form: handler }
        }
      );

      const result = await connection.handleElicitationRequest(elicitRequest);

      expect(result).toEqual({ action: "accept", content: { name: "Alice" } });
      expect(handler).toHaveBeenCalledWith(elicitRequest);
    });

    it("keeps the throwing default when no handler is injected", async () => {
      const connection = new MCPClientConnection(
        new URL("http://example.com/mcp"),
        { name: "test-client", version: "1.0.0" },
        { transport: { type: "streamable-http" }, client: {} }
      );

      await expect(
        connection.handleElicitationRequest(elicitRequest)
      ).rejects.toThrow("Elicitation handler must be implemented");
    });

    it("re-initializing a live connection picks up handler changes in the new handshake", async () => {
      const name = crypto.randomUUID();
      const connection = new MCPClientConnection(
        new URL(`rpc://${name}`),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "rpc", namespace: env.MCP_OBJECT, name },
          client: {},
          elicitationHandlers: {
            form: async () => ({ action: "accept", content: {} })
          }
        }
      );
      await connection.init();
      expect(advertisedCapabilities(connection).elicitation).toEqual({
        form: {}
      });

      // Widening handlers on a live connection takes effect on reconnect —
      // init() re-entry rebuilds the client for the new handshake
      connection.configureElicitationHandlers({
        form: async () => ({ action: "accept", content: {} }),
        url: async () => ({ action: "accept", content: {} })
      });
      expect(advertisedCapabilities(connection).elicitation).toEqual({
        form: {}
      });

      await connection.init();
      expect(advertisedCapabilities(connection).elicitation).toEqual({
        form: {},
        url: {}
      });
    });

    it("completes an elicitation round-trip via RPC using the injected handler", async () => {
      const name = crypto.randomUUID();
      const connection = new MCPClientConnection(
        new URL(`rpc://${name}`),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "rpc", namespace: env.MCP_OBJECT, name },
          client: {},
          elicitationHandlers: {
            form: async () => ({
              action: "accept",
              content: { name: "Alice" }
            })
          }
        }
      );
      await connection.init();

      const result = await connection.client.callTool({
        name: "elicitNameCustom",
        arguments: {}
      });

      expect(result.content).toEqual([
        { type: "text", text: "Custom elicit: Alice" }
      ]);
    });
  });

  describe("MCPClientManager wiring", () => {
    function createMockStorage() {
      const rows = new Map<string, MCPServerRow>();
      const kv = new Map<string, unknown>();
      const exec = <T extends Record<string, SqlStorageValue>>(
        query: string,
        ...values: SqlStorageValue[]
      ) => {
        const results: T[] = [];
        if (query.includes("INSERT OR REPLACE")) {
          rows.set(values[0] as string, {
            id: values[0] as string,
            name: values[1] as string,
            server_url: values[2] as string,
            client_id: values[3] as string | null,
            auth_url: values[4] as string | null,
            callback_url: values[5] as string,
            server_options: values[6] as string | null
          });
        } else if (query.includes("UPDATE") && query.includes("SET id = ?")) {
          const [newId, oldId] = values as [string, string];
          const row = rows.get(oldId);
          if (row) {
            rows.delete(oldId);
            rows.set(newId, { ...row, id: newId });
          }
        } else if (query.includes("SELECT")) {
          if (query.includes("WHERE id = ?")) {
            const row = rows.get(values[0] as string);
            if (row) results.push(row as unknown as T);
          } else {
            results.push(...(Array.from(rows.values()) as unknown as T[]));
          }
        }
        return results[Symbol.iterator]();
      };
      const storage = {
        sql: { exec },
        get: async <T>(key: string) => kv.get(key) as T | undefined,
        put: async (key: string, value: unknown) => {
          kv.set(key, value);
        },
        list: async () => new Map(),
        kv: {
          get: <T>(key: string) => kv.get(key) as T | undefined,
          put: (key: string, value: unknown) => {
            kv.set(key, value);
          },
          list: vi.fn(),
          delete: vi.fn()
        }
      } as unknown as DurableObjectStorage;
      return { storage, rows };
    }

    it("configureElicitationHandlers applies to future connections", async () => {
      const { storage } = createMockStorage();
      const handler = vi
        .fn()
        .mockResolvedValue({ action: "accept", content: { name: "Alice" } });
      const manager = new MCPClientManager("test-client", "1.0.0", {
        storage
      });

      manager.configureElicitationHandlers({ form: handler, url: handler });
      await manager.registerServer("srv-1", {
        url: "http://example.com/mcp",
        name: "example"
      });

      const connection = manager.mcpConnections["srv-1"];
      expect(advertisedCapabilities(connection).elicitation).toEqual({
        form: {},
        url: {}
      });

      const result = await connection.handleElicitationRequest(elicitRequest);

      expect(result).toEqual({
        action: "accept",
        content: { name: "Alice" }
      });
      expect(handler).toHaveBeenCalledWith(elicitRequest, "srv-1");
    });

    it("configureElicitationHandlers updates existing uninitialized connections", async () => {
      const { storage } = createMockStorage();
      const handler = vi
        .fn()
        .mockResolvedValue({ action: "decline", content: {} });
      const manager = new MCPClientManager("test-client", "1.0.0", {
        storage
      });

      await manager.registerServer("srv-1", {
        url: "http://example.com/mcp",
        name: "example"
      });
      const connection = manager.mcpConnections["srv-1"];
      expect(advertisedCapabilities(connection).elicitation).toBeUndefined();

      manager.configureElicitationHandlers({ form: handler, url: handler });

      expect(advertisedCapabilities(connection).elicitation).toEqual({
        form: {},
        url: {}
      });
      const result = await connection.handleElicitationRequest(elicitRequest);
      expect(result).toEqual({ action: "decline", content: {} });
      expect(handler).toHaveBeenCalledWith(elicitRequest, "srv-1");
    });

    it("configureElicitationHandlers can clear an uninitialized connection handler", async () => {
      const { storage } = createMockStorage();
      const manager = new MCPClientManager("test-client", "1.0.0", {
        storage
      });

      manager.configureElicitationHandlers({
        form: async () => ({
          action: "accept",
          content: {}
        })
      });
      await manager.registerServer("srv-1", {
        url: "http://example.com/mcp",
        name: "example"
      });

      const connection = manager.mcpConnections["srv-1"];
      expect(advertisedCapabilities(connection).elicitation).toEqual({
        form: {}
      });

      manager.configureElicitationHandlers(undefined);

      expect(advertisedCapabilities(connection).elicitation).toBeUndefined();
      await expect(
        connection.handleElicitationRequest(elicitRequest)
      ).rejects.toThrow("Elicitation handler must be implemented");
    });

    it("scopes the manager-level handler to each connection with its server id", async () => {
      const { storage } = createMockStorage();
      const handler = vi
        .fn()
        .mockResolvedValue({ action: "decline", content: {} });
      const manager = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      manager.configureElicitationHandlers({ form: handler, url: handler });

      await manager.registerServer("srv-1", {
        url: "http://example.com/mcp",
        name: "example"
      });

      const connection = manager.mcpConnections["srv-1"];
      const result = await connection.handleElicitationRequest(elicitRequest);

      expect(result).toEqual({ action: "decline", content: {} });
      expect(handler).toHaveBeenCalledWith(elicitRequest, "srv-1");
    });

    it("rescopes the handler to the new id after a server id migration", async () => {
      const { storage } = createMockStorage();
      const handler = vi
        .fn()
        .mockResolvedValue({ action: "accept", content: {} });
      const manager = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      manager.configureElicitationHandlers({ form: handler, url: handler });

      await manager.registerServer("old-id", {
        url: "http://example.com/mcp",
        name: "example"
      });
      await manager.migrateServerId("old-id", "github", "test-client");

      const migrated = manager.mcpConnections.github;
      await migrated.handleElicitationRequest(elicitRequest);

      expect(handler).toHaveBeenCalledWith(elicitRequest, "github");
    });

    it("rewires the handler and restores declared capabilities after hibernation", async () => {
      const { storage } = createMockStorage();
      const handlerA = vi.fn();
      const managerA = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      managerA.configureElicitationHandlers({ form: handlerA, url: handlerA });

      await managerA.registerServer("srv-1", {
        url: "http://example.com/mcp",
        name: "example",
        callbackUrl: "http://example.com/callback",
        // Auth in progress → restore recreates the connection without dialing out
        authUrl: "http://example.com/authorize",
        // Narrower than the handler-driven default — proves the restored
        // connection uses the persisted declaration, not the default.
        client: { capabilities: { elicitation: { form: {} } } }
      });

      // Simulate a hibernation wake-up: a fresh manager over the same storage
      const handlerB = vi
        .fn()
        .mockResolvedValue({ action: "cancel", content: {} });
      const managerB = new MCPClientManager("test-client", "1.0.0", {
        storage,
        createAuthProvider: () =>
          ({ serverId: undefined, clientId: undefined }) as never
      });
      managerB.configureElicitationHandlers({ form: handlerB, url: handlerB });
      await managerB.restoreConnectionsFromStorage("test-client");

      const restored = managerB.mcpConnections["srv-1"];
      expect(restored).toBeDefined();

      // Declared elicitation modes survived persistence and beat the default
      expect(advertisedCapabilities(restored).elicitation).toEqual({
        form: {}
      });

      // The new manager's handler is wired with the original server id
      const result = await restored.handleElicitationRequest(elicitRequest);
      expect(result).toEqual({ action: "cancel", content: {} });
      expect(handlerB).toHaveBeenCalledWith(elicitRequest, "srv-1");
    });

    it("dispatches form and url elicitations to their configured handlers", async () => {
      const { storage } = createMockStorage();
      const formHandler = vi
        .fn()
        .mockResolvedValue({ action: "accept", content: { name: "Alice" } });
      const urlHandler = vi
        .fn()
        .mockResolvedValue({ action: "accept", content: {} });
      const manager = new MCPClientManager("test-client", "1.0.0", {
        storage
      });

      manager.configureElicitationHandlers({
        form: formHandler,
        url: urlHandler
      });
      await manager.registerServer("srv-1", {
        url: "http://example.com/mcp",
        name: "example"
      });

      const connection = manager.mcpConnections["srv-1"];
      expect(advertisedCapabilities(connection).elicitation).toEqual({
        form: {},
        url: {}
      });

      await expect(
        connection.handleElicitationRequest(elicitRequest)
      ).resolves.toEqual({
        action: "accept",
        content: { name: "Alice" }
      });
      await expect(
        connection.handleElicitationRequest(urlElicitRequest)
      ).resolves.toEqual({
        action: "accept",
        content: {}
      });
      expect(formHandler).toHaveBeenCalledWith(elicitRequest, "srv-1");
      expect(urlHandler).toHaveBeenCalledWith(urlElicitRequest, "srv-1");
    });

    it("re-advertises persisted capabilities on restore before handlers are reconfigured", async () => {
      const { storage, rows } = createMockStorage();
      const managerA = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      managerA.configureElicitationHandlers({
        form: async () => ({ action: "accept", content: {} }),
        url: async () => ({ action: "accept", content: {} })
      });
      await managerA.registerServer("srv-1", {
        url: "http://example.com/mcp",
        name: "example",
        callbackUrl: "http://example.com/callback",
        // Auth in progress → restore recreates the connection without dialing out
        authUrl: "http://example.com/authorize"
      });

      // Wake after hibernation: restore runs (before fiber/chat recovery)
      // while no handlers are configured yet
      const managerB = new MCPClientManager("test-client", "1.0.0", {
        storage,
        createAuthProvider: () =>
          ({ serverId: undefined, clientId: undefined }) as never
      });
      await managerB.restoreConnectionsFromStorage("test-client");

      const restored = managerB.mcpConnections["srv-1"];
      expect(advertisedCapabilities(restored).elicitation).toEqual({
        form: {},
        url: {}
      });
      // A request in the pre-onStart window fails loudly instead of crashing
      await expect(
        restored.handleElicitationRequest(elicitRequest)
      ).rejects.toThrow("Elicitation handler must be implemented");

      // onStart re-attaches handlers to the live connection
      const handler = vi
        .fn()
        .mockResolvedValue({ action: "accept", content: { name: "Alice" } });
      managerB.configureElicitationHandlers({ form: handler, url: handler });

      await expect(
        restored.handleElicitationRequest(elicitRequest)
      ).resolves.toEqual({ action: "accept", content: { name: "Alice" } });
      expect(handler).toHaveBeenCalledWith(elicitRequest, "srv-1");
      expect(advertisedCapabilities(restored).elicitation).toEqual({
        form: {},
        url: {}
      });

      // A session that only handles form narrows the advertised modes and
      // updates the stored row for the next wake
      managerB.configureElicitationHandlers({ form: handler });
      expect(advertisedCapabilities(restored).elicitation).toEqual({
        form: {}
      });
      const options = JSON.parse(rows.get("srv-1")?.server_options ?? "{}");
      expect(options.capabilities).toEqual({ elicitation: { form: {} } });
    });

    it("the persisted capability survives one restore, then requires reconfiguration", async () => {
      const { storage } = createMockStorage();
      const managerA = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      managerA.configureElicitationHandlers({
        form: async () => ({ action: "accept", content: {} })
      });
      await managerA.registerServer("srv-1", {
        url: "http://example.com/mcp",
        name: "example",
        callbackUrl: "http://example.com/callback",
        authUrl: "http://example.com/authorize"
      });

      // First wake after the deploy stopped configuring handlers: the stamp
      // still seeds the connection once
      const managerB = new MCPClientManager("test-client", "1.0.0", {
        storage,
        createAuthProvider: () =>
          ({ serverId: undefined, clientId: undefined }) as never
      });
      await managerB.restoreConnectionsFromStorage("test-client");
      expect(
        advertisedCapabilities(managerB.mcpConnections["srv-1"]).elicitation
      ).toEqual({ form: {} });

      // Second wake with no configure call in between: the stale mode is no
      // longer advertised, so servers use their non-elicitation fallbacks
      const managerC = new MCPClientManager("test-client", "1.0.0", {
        storage,
        createAuthProvider: () =>
          ({ serverId: undefined, clientId: undefined }) as never
      });
      await managerC.restoreConnectionsFromStorage("test-client");
      expect(
        advertisedCapabilities(managerC.mcpConnections["srv-1"]).elicitation
      ).toBeUndefined();
    });

    it("a server id migration preserves the restored capability seed", async () => {
      const { storage } = createMockStorage();
      const managerA = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      managerA.configureElicitationHandlers({
        url: async () => ({ action: "accept", content: {} })
      });
      await managerA.registerServer("old-id", {
        url: "http://example.com/mcp",
        name: "example",
        callbackUrl: "http://example.com/callback",
        authUrl: "http://example.com/authorize"
      });

      // Restore without configuring handlers (the pre-onStart window), then
      // migrate the id — the seed must survive the rescope
      const managerB = new MCPClientManager("test-client", "1.0.0", {
        storage,
        createAuthProvider: () =>
          ({ serverId: undefined, clientId: undefined }) as never
      });
      await managerB.restoreConnectionsFromStorage("test-client");
      await managerB.migrateServerId("old-id", "github", "test-client");

      expect(
        advertisedCapabilities(managerB.mcpConnections.github).elicitation
      ).toEqual({ url: {} });
    });

    it("records the advertised capability on stored rows as handlers change", async () => {
      const { storage, rows } = createMockStorage();
      const manager = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      const parse = () => JSON.parse(rows.get("srv-1")?.server_options ?? "{}");

      await manager.registerServer("srv-1", {
        url: "http://example.com/mcp",
        name: "example"
      });
      expect(parse().capabilities).toBeUndefined();

      manager.configureElicitationHandlers({
        url: async () => ({ action: "cancel", content: {} })
      });
      expect(parse().capabilities).toEqual({ elicitation: { url: {} } });

      manager.configureElicitationHandlers(undefined);
      expect(parse().capabilities).toBeUndefined();
    });

    it("stamps the current capability onto rows registered after configuration", async () => {
      const { storage, rows } = createMockStorage();
      const manager = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      manager.configureElicitationHandlers({
        form: async () => ({ action: "accept", content: {} })
      });

      await manager.registerServer("srv-http", {
        url: "http://example.com/mcp",
        name: "example"
      });
      manager.saveRpcServerToStorage("srv-rpc", "counter", "counter", "MCP");

      for (const id of ["srv-http", "srv-rpc"]) {
        const options = JSON.parse(rows.get(id)?.server_options ?? "{}");
        expect(options.capabilities).toEqual({ elicitation: { form: {} } });
      }
    });

    it("seeds capabilities on a live connection and attaches handlers after connect", async () => {
      const { storage } = createMockStorage();
      const name = crypto.randomUUID();

      // Previous session: handlers configured, RPC server row stamped
      const managerA = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      managerA.configureElicitationHandlers({
        form: async () => ({ action: "accept", content: {} })
      });
      managerA.saveRpcServerToStorage("srv-rpc", "rpc-server", name, "MCP");

      // Wake: the Agent RPC restore path reconnects by stored id before any
      // handler exists — the manager seeds capabilities from its own row
      const managerB = new MCPClientManager("test-client", "1.0.0", {
        storage
      });
      await managerB.connect(`rpc://${name}`, {
        reconnect: { id: "srv-rpc" },
        transport: { type: "rpc", namespace: env.MCP_OBJECT, name }
      });

      const conn = managerB.mcpConnections["srv-rpc"];
      expect(advertisedCapabilities(conn).elicitation).toEqual({ form: {} });

      // Handlers attach to the already-connected client — no rebuild
      managerB.configureElicitationHandlers({
        form: async () => ({ action: "accept", content: { name: "Alice" } })
      });
      expect(advertisedCapabilities(conn).elicitation).toEqual({ form: {} });

      const result = await conn.client.callTool({
        name: "elicitNameCustom",
        arguments: {}
      });
      expect(result.content).toEqual([
        { type: "text", text: "Custom elicit: Alice" }
      ]);
    });

    it("advertises only configured modes and fails loudly without a matching handler", async () => {
      const { storage } = createMockStorage();
      const urlHandler = vi
        .fn()
        .mockResolvedValue({ action: "accept", content: {} });
      const manager = new MCPClientManager("test-client", "1.0.0", {
        storage
      });

      manager.configureElicitationHandlers({ url: urlHandler });
      await manager.registerServer("srv-1", {
        url: "http://example.com/mcp",
        name: "example"
      });

      const connection = manager.mcpConnections["srv-1"];
      expect(advertisedCapabilities(connection).elicitation).toEqual({
        url: {}
      });

      await expect(
        connection.handleElicitationRequest(elicitRequest)
      ).rejects.toThrow("No MCP form-mode elicitation handler configured");
      await expect(
        connection.handleElicitationRequest(urlElicitRequest)
      ).resolves.toEqual({
        action: "accept",
        content: {}
      });
    });
  });
});
