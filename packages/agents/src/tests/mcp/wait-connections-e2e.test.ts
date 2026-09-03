import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { getStubByName } from "../..";

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

  describe("Agent startup restoration after eviction", () => {
    it("should settle connections when waiting after onStart", async () => {
      const name = "hibernation-roundtrip";
      let stub = await getStubByName(env.TestWaitConnectionsAgent, name);

      // Insert an MCP server row (simulating state from before hibernation).
      await stub.insertMcpServer(
        "roundtrip-server",
        "Round Trip Server",
        "http://nonexistent-mcp.example.com",
        "http://localhost:3000/callback",
        null
      );

      // Eviction tears down the instance while retaining SQLite. Resolving the
      // Agent again runs the real lifecycle capability startup path.
      await evictDurableObject(stub);
      stub = await getStubByName(env.TestWaitConnectionsAgent, name);
      const result = await stub.waitAndReport(5000);

      expect(result.connectionIds).toContain("roundtrip-server");
      const state = result.connectionStates["roundtrip-server"];
      expect(state).toBeDefined();
      expect(state).not.toBe("connecting");
    });

    it("should show race condition without waiting after onStart", async () => {
      const name = "hibernation-race";
      let stub = await getStubByName(env.TestWaitConnectionsAgent, name);

      await stub.insertMcpServer(
        "race-roundtrip-server",
        "Race Round Trip Server",
        "http://nonexistent-mcp.example.com",
        "http://localhost:3000/callback",
        null
      );

      await evictDurableObject(stub);
      stub = await getStubByName(env.TestWaitConnectionsAgent, name);
      const result = await stub.reportWithoutWait();

      expect(result.connectionIds).toContain("race-roundtrip-server");
      expect(result.connectionStates["race-roundtrip-server"]).toBe(
        "connecting"
      );
    });

    it("should handle mixed server types through onStart lifecycle", async () => {
      const name = "hibernation-mixed";
      let stub = await getStubByName(env.TestWaitConnectionsAgent, name);

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

      await evictDurableObject(stub);
      stub = await getStubByName(env.TestWaitConnectionsAgent, name);
      const result = await stub.waitAndReport(5000);

      expect(result.connectionIds).toContain("regular-server");
      expect(result.connectionIds).toContain("oauth-server");
      expect(result.connectionStates["regular-server"]).not.toBe("connecting");
      expect(result.connectionStates["oauth-server"]).toBe("authenticating");
    });

    // This forces a running actor out of memory. It verifies reconstruction,
    // not natural idle-hibernation eligibility.
    it("automatically restores MCP connections after forced eviction", async () => {
      const name = `forced-evict-${crypto.randomUUID()}`;
      let stub = await getStubByName(env.TestWaitConnectionsAgent, name);

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

      // Re-routing through getStubByName runs the normal Agent startup wrapper.
      // waitAndReport only waits for that lifecycle-started restore; it does not
      // manually invoke onStart() or restoreConnectionsFromStorage().
      stub = await getStubByName(env.TestWaitConnectionsAgent, name);
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
