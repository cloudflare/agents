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

function advertisedCapabilities(
  connection: MCPClientConnection
): ClientCapabilities {
  return (connection.client as unknown as { _capabilities: ClientCapabilities })
    ._capabilities;
}

describe("MCP client elicitation options (#1875)", () => {
  describe("capability negotiation", () => {
    it("defaults to form-mode-only elicitation without a handler", () => {
      const connection = new MCPClientConnection(
        new URL("http://example.com/mcp"),
        { name: "test-client", version: "1.0.0" },
        { transport: { type: "streamable-http" }, client: {} }
      );

      expect(advertisedCapabilities(connection).elicitation).toEqual({});
    });

    it("defaults to form- and url-mode elicitation with a handler", () => {
      const connection = new MCPClientConnection(
        new URL("http://example.com/mcp"),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "streamable-http" },
          client: {},
          elicitationHandler: async () => ({ action: "cancel", content: {} })
        }
      );

      expect(advertisedCapabilities(connection).elicitation).toEqual({
        form: {},
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
          elicitationHandler: async () => ({ action: "cancel", content: {} })
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
          elicitationHandler: handler
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

    it("completes an elicitation round-trip via RPC using the injected handler", async () => {
      const name = crypto.randomUUID();
      const connection = new MCPClientConnection(
        new URL(`rpc://${name}`),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "rpc", namespace: env.MCP_OBJECT, name },
          client: {},
          elicitationHandler: async () => ({
            action: "accept",
            content: { name: "Alice" }
          })
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

    it("scopes the manager-level handler to each connection with its server id", async () => {
      const { storage } = createMockStorage();
      const handler = vi
        .fn()
        .mockResolvedValue({ action: "decline", content: {} });
      const manager = new MCPClientManager("test-client", "1.0.0", {
        storage,
        elicitationHandler: handler
      });

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
        storage,
        elicitationHandler: handler
      });

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
        storage,
        elicitationHandler: handlerA
      });

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
          ({ serverId: undefined, clientId: undefined }) as never,
        elicitationHandler: handlerB
      });
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
  });
});
