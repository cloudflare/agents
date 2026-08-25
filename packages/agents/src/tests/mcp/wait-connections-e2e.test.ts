import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { getAgentByName } from "../..";

/**
 * E2E tests for waitForConnections() through the full Agent lifecycle.
 *
 * These tests exercise the complete flow:
 *   Agent wake → onStart → restoreConnectionsFromStorage → _trackConnection
 *   → waitForConnections() → getAITools()
 *
 * Unlike the unit tests in client-manager.test.ts which mock storage,
 * these run against real Durable Object stubs with SQLite.
 */
describe("waitForConnections E2E", () => {
  it("initializes a cold Agent before an application RPC method executes", async () => {
    // Arrange: seed persisted MCP state through synchronous SQL without running
    // the Agent lifecycle.
    const agentId = env.TestWaitConnectionsAgent.idFromName(
      `cold-custom-rpc-${crypto.randomUUID()}`
    );
    const stub = env.TestWaitConnectionsAgent.get(agentId);

    stub.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_mcp_servers (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        server_url TEXT NOT NULL,
        callback_url TEXT NOT NULL,
        client_id TEXT,
        auth_url TEXT,
        server_options TEXT
      )
    `;
    stub.sql`
      INSERT INTO cf_agents_mcp_servers (
        id, name, server_url, callback_url, client_id, auth_url, server_options
      ) VALUES (
        'cold-custom-server',
        'Cold Custom Server',
        'http://cold-custom.example.com',
        'http://localhost:3000/callback',
        NULL,
        NULL,
        NULL
      )
    `;

    // Act: waitAndReport is a test-fixture application RPC that waits for the
    // MCP restores started by onStart, then reports their in-memory state
    // without triggering another restore.
    const result = await stub.waitAndReport();

    // Assert
    expect(result.connectionIds).toContain("cold-custom-server");
  });

  it("initializes a cold Agent before an inherited Agent RPC method executes", async () => {
    // Arrange: seed persisted MCP state through synchronous SQL without running
    // the Agent lifecycle.
    const agentId = env.TestWaitConnectionsAgent.idFromName(
      `cold-base-rpc-${crypto.randomUUID()}`
    );
    const stub = env.TestWaitConnectionsAgent.get(agentId);

    stub.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_mcp_servers (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        server_url TEXT NOT NULL,
        callback_url TEXT NOT NULL,
        client_id TEXT,
        auth_url TEXT,
        server_options TEXT
      )
    `;
    stub.sql`
      INSERT INTO cf_agents_mcp_servers (
        id, name, server_url, callback_url, client_id, auth_url, server_options
      ) VALUES (
        'cold-base-server',
        'Cold Base Server',
        'http://cold-base.example.com',
        'http://localhost:3000/callback',
        NULL,
        NULL,
        NULL
      )
    `;

    // Act: getMcpServers is the inherited Agent RPC whose cold invocation must
    // restore the persisted MCP server before it reads the in-memory view.
    const result = await (
      stub as unknown as {
        getMcpServers(): Promise<{
          servers: Record<string, { state: string }>;
        }>;
      }
    ).getMcpServers();

    // Assert
    expect(result.servers["cold-base-server"]?.state).toBe("connecting");
  });

  it("should resolve immediately when agent has no MCP servers", async () => {
    const agentId = env.TestWaitConnectionsAgent.idFromName("no-servers-test");
    const stub = env.TestWaitConnectionsAgent.get(agentId);

    await stub.__unsafe_ensureInitialized();

    const isImmediate = await stub.waitWithNoPending();
    expect(isImmediate).toBe(true);
  });

  it("should wait for restore-initiated connections to settle", async () => {
    const agentId = env.TestWaitConnectionsAgent.idFromName("restore-wait-e2e");
    const stub = env.TestWaitConnectionsAgent.get(agentId);

    // Create the MCP table (simulating agent initialization)
    stub.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_mcp_servers (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        server_url TEXT NOT NULL,
        callback_url TEXT NOT NULL,
        client_id TEXT,
        auth_url TEXT,
        server_options TEXT
      )
    `;

    // Insert an MCP server (simulating pre-hibernation state)
    await stub.insertMcpServer(
      "e2e-server-1",
      "Test MCP Server",
      "http://nonexistent-mcp.example.com",
      "http://localhost:3000/callback",
      null
    );

    // Reset so restore runs fresh
    await stub.resetRestoredFlag();

    // Restore and wait — the connection will fail (mock, no real server)
    // but waitForConnections should resolve without hanging
    const result = await stub.restoreAndWait(5000);

    expect(result.connectionIds).toContain("e2e-server-1");
    // Connection should be in a terminal state after waiting
    const state = result.connectionStates["e2e-server-1"];
    expect(state).toBeDefined();
    // Should NOT be "connecting" — it should have settled
    expect(state).not.toBe("connecting");
  });

  it("should show connections in non-ready state without waiting (race condition demo)", async () => {
    const agentId = env.TestWaitConnectionsAgent.idFromName(
      "race-condition-demo"
    );
    const stub = env.TestWaitConnectionsAgent.get(agentId);

    stub.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_mcp_servers (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        server_url TEXT NOT NULL,
        callback_url TEXT NOT NULL,
        client_id TEXT,
        auth_url TEXT,
        server_options TEXT
      )
    `;

    await stub.insertMcpServer(
      "race-server",
      "Race Test Server",
      "http://slow-mcp.example.com",
      "http://localhost:3000/callback",
      null
    );

    await stub.resetRestoredFlag();

    // Restore WITHOUT waiting — check state immediately
    const result = await stub.restoreWithoutWait();

    expect(result.connectionIds).toContain("race-server");
    // Without waiting, connection is likely still in "connecting" state
    // (this demonstrates the race condition the fix addresses)
    const state = result.connectionStates["race-server"];
    expect(state).toBeDefined();
    // State should be "connecting" since we didn't wait
    expect(state).toBe("connecting");
  });

  it("should handle OAuth servers that skip restore (authenticating state)", async () => {
    const agentId = env.TestWaitConnectionsAgent.idFromName("oauth-skip-e2e");
    const stub = env.TestWaitConnectionsAgent.get(agentId);

    stub.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_mcp_servers (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        server_url TEXT NOT NULL,
        callback_url TEXT NOT NULL,
        client_id TEXT,
        auth_url TEXT,
        server_options TEXT
      )
    `;

    // Insert a server with auth_url — this means OAuth is in progress
    await stub.insertMcpServer(
      "oauth-server",
      "OAuth Server",
      "http://oauth-mcp.example.com",
      "http://localhost:3000/callback",
      "https://auth.example.com/authorize"
    );

    await stub.resetRestoredFlag();

    // Restore and wait — OAuth servers are set to authenticating
    // and NOT tracked as pending, so wait should be near-instant
    const result = await stub.restoreAndWait();

    expect(result.connectionIds).toContain("oauth-server");
    expect(result.connectionStates["oauth-server"]).toBe("authenticating");
  });

  describe("true hibernation round-trip (onStart lifecycle)", () => {
    it("should settle connections when waiting after onStart", async () => {
      const agentId = env.TestWaitConnectionsAgent.idFromName(
        "hibernation-roundtrip"
      );
      const stub = env.TestWaitConnectionsAgent.get(agentId);

      // Boot the agent initially (creates tables, etc.)
      await stub.__unsafe_ensureInitialized();

      // Insert an MCP server row (simulating state from before hibernation)
      await stub.insertMcpServer(
        "roundtrip-server",
        "Round Trip Server",
        "http://nonexistent-mcp.example.com",
        "http://localhost:3000/callback",
        null
      );

      // Simulate hibernation: reset in-memory state so onStart re-restores
      await stub.resetRestoredFlag();

      // Full round-trip: onStart → restoreConnectionsFromStorage (fires
      // _trackConnection internally) → waitForConnections
      const result = await stub.hibernationRoundTrip(5000);

      expect(result.connectionIds).toContain("roundtrip-server");
      // Connection should have settled (failed, since no real server)
      // — NOT still "connecting"
      const state = result.connectionStates["roundtrip-server"];
      expect(state).toBeDefined();
      expect(state).not.toBe("connecting");
    });

    it("should show race condition without waiting after onStart", async () => {
      const agentId =
        env.TestWaitConnectionsAgent.idFromName("hibernation-race");
      const stub = env.TestWaitConnectionsAgent.get(agentId);

      await stub.__unsafe_ensureInitialized();

      await stub.insertMcpServer(
        "race-roundtrip-server",
        "Race Round Trip Server",
        "http://nonexistent-mcp.example.com",
        "http://localhost:3000/callback",
        null
      );

      await stub.resetRestoredFlag();

      // Round-trip WITHOUT waiting — demonstrates the race condition
      const result = await stub.hibernationRoundTripNoWait();

      expect(result.connectionIds).toContain("race-roundtrip-server");
      // Without waiting, connection should still be "connecting"
      expect(result.connectionStates["race-roundtrip-server"]).toBe(
        "connecting"
      );
    });

    it("should handle mixed server types through onStart lifecycle", async () => {
      const agentId =
        env.TestWaitConnectionsAgent.idFromName("hibernation-mixed");
      const stub = env.TestWaitConnectionsAgent.get(agentId);

      await stub.__unsafe_ensureInitialized();

      // Insert one regular server and one OAuth server
      await stub.insertMcpServer(
        "regular-server",
        "Regular Server",
        "http://nonexistent-mcp.example.com",
        "http://localhost:3000/callback",
        null
      );
      await stub.insertMcpServer(
        "oauth-server",
        "OAuth Server",
        "http://oauth-mcp.example.com",
        "http://localhost:3000/callback",
        "https://auth.example.com/authorize"
      );

      await stub.resetRestoredFlag();

      // onStart → restore → wait: OAuth server is not tracked as pending,
      // regular server's promise settles via allSettled
      const result = await stub.hibernationRoundTrip(5000);

      expect(result.connectionIds).toContain("regular-server");
      expect(result.connectionIds).toContain("oauth-server");
      // Regular server should have settled
      expect(result.connectionStates["regular-server"]).not.toBe("connecting");
      // OAuth server should be in authenticating state
      expect(result.connectionStates["oauth-server"]).toBe("authenticating");
    });

    // This forces a running actor out of memory. It verifies reconstruction,
    // not natural idle-hibernation eligibility.
    it("automatically restores MCP connections after forced eviction", async () => {
      const name = `forced-evict-${crypto.randomUUID()}`;
      let stub = await getAgentByName(env.TestWaitConnectionsAgent, name);

      await stub.insertMcpServer(
        "evict-roundtrip-server",
        "Evict Round Trip Server",
        "http://nonexistent-mcp.example.com",
        "http://localhost:3000/callback",
        null
      );
      await stub.resetRestoredFlag();
      await stub.restoreAndWait(5000);
      expect(await stub.hasMcpConnection("evict-roundtrip-server")).toBe(true);

      await evictDurableObject(stub);

      // Re-routing through getAgentByName runs the normal Agent startup wrapper.
      // waitAndReport only waits for that lifecycle-started restore; it does not
      // manually invoke onStart() or restoreConnectionsFromStorage().
      stub = await getAgentByName(env.TestWaitConnectionsAgent, name);
      const result = await stub.waitAndReport(5000);

      expect(result.connectionIds).toContain("evict-roundtrip-server");
      expect(result.connectionStates["evict-roundtrip-server"]).toBe("failed");
    });
  });

  it("should handle timeout when connections are slow", async () => {
    const agentId = env.TestWaitConnectionsAgent.idFromName("timeout-e2e");
    const stub = env.TestWaitConnectionsAgent.get(agentId);

    stub.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_mcp_servers (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        server_url TEXT NOT NULL,
        callback_url TEXT NOT NULL,
        client_id TEXT,
        auth_url TEXT,
        server_options TEXT
      )
    `;

    await stub.insertMcpServer(
      "timeout-server",
      "Timeout Test Server",
      "http://very-slow-mcp.example.com",
      "http://localhost:3000/callback",
      null
    );

    await stub.resetRestoredFlag();

    // Restore and wait with a short timeout
    const start = Date.now();
    const result = await stub.restoreAndWait(100);
    const elapsed = Date.now() - start;

    // Should have returned (not hung)
    expect(elapsed).toBeLessThan(5000);
    expect(result.connectionIds).toContain("timeout-server");
  });
});
