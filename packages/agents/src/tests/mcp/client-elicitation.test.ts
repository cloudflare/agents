import { env } from "cloudflare:workers";
import type {
  ClientCapabilities,
  ElicitRequest
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { MCPClientConnection } from "../../mcp/client/connection";
import { type McpHarness, withMcpHarness } from "../shared/mcp-harness";

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
    function serverOptions(harness: McpHarness, id: string) {
      const row = harness.serverRows().find((r) => r.id === id);
      return JSON.parse(row?.server_options ?? "{}");
    }

    it("configureElicitationHandlers applies to future connections", async () => {
      await withMcpHarness(async (harness) => {
        const handler = vi
          .fn()
          .mockResolvedValue({ action: "accept", content: { name: "Alice" } });
        const manager = harness.createManager();

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
    });

    it("configureElicitationHandlers updates existing uninitialized connections", async () => {
      await withMcpHarness(async (harness) => {
        const handler = vi
          .fn()
          .mockResolvedValue({ action: "decline", content: {} });
        const manager = harness.createManager();

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
    });

    it("configureElicitationHandlers can clear an uninitialized connection handler", async () => {
      await withMcpHarness(async (harness) => {
        const manager = harness.createManager();

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
    });

    it("scopes the manager-level handler to each connection with its server id", async () => {
      await withMcpHarness(async (harness) => {
        const handler = vi
          .fn()
          .mockResolvedValue({ action: "decline", content: {} });
        const manager = harness.createManager();
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
    });

    it("rescopes the handler to the new id after a server id migration", async () => {
      await withMcpHarness(async (harness) => {
        const handler = vi
          .fn()
          .mockResolvedValue({ action: "accept", content: {} });
        const manager = harness.createManager();
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
    });

    it("rewires the handler and restores declared capabilities after hibernation", async () => {
      await withMcpHarness(async (harness) => {
        const handlerA = vi.fn();
        const managerA = harness.createManager();
        managerA.configureElicitationHandlers({
          form: handlerA,
          url: handlerA
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
        const managerB = harness.createManager({
          createAuthProvider: () =>
            ({ serverId: undefined, clientId: undefined }) as never
        });
        managerB.configureElicitationHandlers({
          form: handlerB,
          url: handlerB
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

    it("dispatches form and url elicitations to their configured handlers", async () => {
      await withMcpHarness(async (harness) => {
        const formHandler = vi
          .fn()
          .mockResolvedValue({ action: "accept", content: { name: "Alice" } });
        const urlHandler = vi
          .fn()
          .mockResolvedValue({ action: "accept", content: {} });
        const manager = harness.createManager();

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
    });

    it("re-advertises persisted capabilities on restore before handlers are reconfigured", async () => {
      await withMcpHarness(async (harness) => {
        const managerA = harness.createManager();
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
        const managerB = harness.createManager({
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
        const options = serverOptions(harness, "srv-1");
        expect(options.capabilities).toEqual({ elicitation: { form: {} } });
      });
    });

    it("the persisted capability survives one seeded handshake, then requires reconfiguration", async () => {
      // The stamp is consumed at first use (a completed handshake), not at
      // restore-time read, so the wake must actually connect — done here
      // over RPC.
      await withMcpHarness(async (harness) => {
        const name = crypto.randomUUID();

        const managerA = harness.createManager();
        managerA.configureElicitationHandlers({
          form: async () => ({ action: "accept", content: {} })
        });
        managerA.saveRpcServerToStorage("srv-rpc", "rpc-server", name, "MCP");

        // First connected wake after the deploy stopped configuring handlers:
        // the stamp still seeds the handshake once
        const managerB = harness.createManager();
        await managerB.connect(`rpc://${name}`, {
          reconnect: { id: "srv-rpc" },
          transport: { type: "rpc", namespace: env.MCP_OBJECT, name }
        });
        expect(
          advertisedCapabilities(managerB.mcpConnections["srv-rpc"]).elicitation
        ).toEqual({ form: {} });

        // The completed seeded handshake consumed the stamp
        const options = serverOptions(harness, "srv-rpc");
        expect(options.capabilities).toBeUndefined();

        // Next wake with no configure call in between: the stale mode is no
        // longer advertised, so servers use their non-elicitation fallbacks
        const managerC = harness.createManager();
        await managerC.connect(`rpc://${name}`, {
          reconnect: { id: "srv-rpc" },
          transport: { type: "rpc", namespace: env.MCP_OBJECT, name }
        });
        expect(
          advertisedCapabilities(managerC.mcpConnections["srv-rpc"]).elicitation
        ).toBeUndefined();
      });
    });

    it("a stable-id re-add in a configuring session keeps the row stamped for the next wake", async () => {
      await withMcpHarness(async (harness) => {
        const name = crypto.randomUUID();

        // Previous session stamped the row under a stable id
        const managerA = harness.createManager();
        managerA.configureElicitationHandlers({
          form: async () => ({ action: "accept", content: {} })
        });
        managerA.saveRpcServerToStorage("srv-rpc", "rpc-server", name, "MCP");

        // New session configures before the connection object exists, then
        // re-adds the same stable id: createConnection reads the row stamp as
        // a seed and registerServer writes a fresh one before the handshake
        const managerB = harness.createManager();
        managerB.configureElicitationHandlers({
          form: async () => ({ action: "accept", content: {} })
        });
        await managerB.registerServer("srv-rpc", {
          url: `rpc://${name}`,
          name: "rpc-server",
          transport: { type: "rpc", namespace: env.MCP_OBJECT, name }
        });
        const result = await managerB.connectToServer("srv-rpc");
        expect(result.state).toBe("connected");

        // The session configures handlers every wake, so the completed
        // handshake must not burn the fresh stamp meant for the next wake
        const options = serverOptions(harness, "srv-rpc");
        expect(options.capabilities).toEqual({ elicitation: { form: {} } });
      });
    });

    it("re-adding a closed server in a configuring session keeps the row stamped", async () => {
      await withMcpHarness(async (harness) => {
        const name = crypto.randomUUID();
        const manager = harness.createManager();
        manager.configureElicitationHandlers({
          url: async () => ({ action: "accept", content: {} })
        });
        const register = () =>
          manager.registerServer("srv-rpc", {
            url: `rpc://${name}`,
            name: "rpc-server",
            transport: { type: "rpc", namespace: env.MCP_OBJECT, name }
          });
        await register();
        await manager.connectToServer("srv-rpc");
        // The row (and its stamp) survives the close; only removeServer deletes it
        await manager.closeConnection("srv-rpc");

        // Re-add: createConnection reads the stamped row as a seed before
        // registerServer re-stamps it and the handshake completes
        await register();
        await manager.connectToServer("srv-rpc");

        const options = serverOptions(harness, "srv-rpc");
        expect(options.capabilities).toEqual({ elicitation: { url: {} } });
      });
    });

    it("an OAuth-pending restore keeps the capability seed for the wake that connects", async () => {
      await withMcpHarness(async (harness) => {
        const managerA = harness.createManager();
        managerA.configureElicitationHandlers({
          form: async () => ({ action: "accept", content: {} })
        });
        await managerA.registerServer("srv-1", {
          url: "http://example.com/mcp",
          name: "example",
          callbackUrl: "http://example.com/callback",
          authUrl: "http://example.com/authorize"
        });

        // Wake 1: OAuth is still pending, so restore parks the connection in
        // AUTHENTICATING and never handshakes — the stamp must not be burned
        const managerB = harness.createManager({
          createAuthProvider: () =>
            ({ serverId: undefined, clientId: undefined }) as never
        });
        await managerB.restoreConnectionsFromStorage("test-client");
        expect(managerB.mcpConnections["srv-1"].connectionState).toBe(
          "authenticating"
        );
        const options = serverOptions(harness, "srv-1");
        expect(options.capabilities).toEqual({ elicitation: { form: {} } });

        // Wake 2: the seed still covers the handshake
        const managerC = harness.createManager({
          createAuthProvider: () =>
            ({ serverId: undefined, clientId: undefined }) as never
        });
        await managerC.restoreConnectionsFromStorage("test-client");
        expect(
          advertisedCapabilities(managerC.mcpConnections["srv-1"]).elicitation
        ).toEqual({ form: {} });
      });
    });

    it("a wake interrupted before the handshake does not burn the capability seed", async () => {
      await withMcpHarness(async (harness) => {
        const managerA = harness.createManager();
        managerA.configureElicitationHandlers({
          url: async () => ({ action: "accept", content: {} })
        });
        await managerA.registerServer("srv-1", {
          url: "http://example.com/mcp",
          name: "example"
        });

        // Wake 1 is interrupted between restore and the handshake (deploy
        // reset, OOM, a throw before onStart re-stamps): init never connects
        const initSpy = vi
          .spyOn(MCPClientConnection.prototype, "init")
          .mockResolvedValue(undefined);
        try {
          const managerB = harness.createManager();
          await managerB.restoreConnectionsFromStorage("test-client");
          await managerB.waitForConnections();

          const options = serverOptions(harness, "srv-1");
          expect(options.capabilities).toEqual({ elicitation: { url: {} } });

          // Wake 2 still seeds the handshake with the stamped capability
          const managerC = harness.createManager();
          await managerC.restoreConnectionsFromStorage("test-client");
          await managerC.waitForConnections();
          expect(
            advertisedCapabilities(managerC.mcpConnections["srv-1"]).elicitation
          ).toEqual({ url: {} });
        } finally {
          initSpy.mockRestore();
        }
      });
    });

    it("a server id migration preserves the restored capability seed", async () => {
      await withMcpHarness(async (harness) => {
        const managerA = harness.createManager();
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
        const managerB = harness.createManager({
          createAuthProvider: () =>
            ({ serverId: undefined, clientId: undefined }) as never
        });
        await managerB.restoreConnectionsFromStorage("test-client");
        await managerB.migrateServerId("old-id", "github", "test-client");

        expect(
          advertisedCapabilities(managerB.mcpConnections.github).elicitation
        ).toEqual({ url: {} });
      });
    });

    it("records the advertised capability on stored rows as handlers change", async () => {
      await withMcpHarness(async (harness) => {
        const manager = harness.createManager();
        const parse = () => serverOptions(harness, "srv-1");

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
    });

    it("stamps the current capability onto rows registered after configuration", async () => {
      await withMcpHarness(async (harness) => {
        const manager = harness.createManager();
        manager.configureElicitationHandlers({
          form: async () => ({ action: "accept", content: {} })
        });

        await manager.registerServer("srv-http", {
          url: "http://example.com/mcp",
          name: "example"
        });
        manager.saveRpcServerToStorage("srv-rpc", "counter", "counter", "MCP");

        for (const id of ["srv-http", "srv-rpc"]) {
          const options = serverOptions(harness, id);
          expect(options.capabilities).toEqual({ elicitation: { form: {} } });
        }
      });
    });

    it("seeds capabilities on a live connection and attaches handlers after connect", async () => {
      await withMcpHarness(async (harness) => {
        const name = crypto.randomUUID();

        // Previous session: handlers configured, RPC server row stamped
        const managerA = harness.createManager();
        managerA.configureElicitationHandlers({
          form: async () => ({ action: "accept", content: {} })
        });
        managerA.saveRpcServerToStorage("srv-rpc", "rpc-server", name, "MCP");

        // Wake: RPC restoration reconnects by stored id before any handler
        // exists, so the manager seeds capabilities from its own row.
        const managerB = harness.createManager();
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
    });

    it("advertises only configured modes and fails loudly without a matching handler", async () => {
      await withMcpHarness(async (harness) => {
        const urlHandler = vi
          .fn()
          .mockResolvedValue({ action: "accept", content: {} });
        const manager = harness.createManager();

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
});
