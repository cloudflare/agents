/**
 * Integration tests for AgentClient.
 * Tests connection lifecycle, identity, state sync, and RPC calls
 * against a real miniflare worker.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentClient, agentFetch } from "../client";
import { getTestWorkerHost, getTestWorkerUrl } from "./test-config";

describe("AgentClient", () => {
  describe("worker connectivity", () => {
    it("should be able to reach the test worker via HTTP", async () => {
      const url = getTestWorkerUrl();
      const response = await fetch(`${url}/agents/test-state-agent/test-http`);
      // 404 or 426 (upgrade required) is expected - just checking connectivity
      expect([404, 426].includes(response.status) || response.ok).toBe(true);
    });
  });

  let client: AgentClient | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (client) {
      client.close();
      client = null;
    }
  });

  describe("connection lifecycle", () => {
    it("should connect and receive identity", async () => {
      const { host, protocol } = getTestWorkerHost();
      const onIdentity = vi.fn();

      client = new AgentClient({
        agent: "TestStateAgent",
        name: "client-test-identity",
        host,
        protocol,
        onIdentity
      });

      // Wait for ready (identity received)
      await client.ready;

      expect(client.identified).toBe(true);
      expect(client.name).toBe("client-test-identity");
      expect(client.agent).toBe("test-state-agent");
      expect(onIdentity).toHaveBeenCalledWith(
        "client-test-identity",
        "test-state-agent"
      );
    });

    it("should reset ready state on close", async () => {
      const { host, protocol } = getTestWorkerHost();

      client = new AgentClient({
        agent: "TestStateAgent",
        name: "client-test-close",
        host,
        protocol
      });

      await client.ready;
      expect(client.identified).toBe(true);

      // Wait for close event
      const closePromise = new Promise<void>((resolve) => {
        client!.addEventListener("close", () => resolve(), { once: true });
      });

      // Close the connection
      client.close();

      // Wait for the close event to be processed
      await closePromise;

      // identified should be false after close
      expect(client.identified).toBe(false);
    });

    it("should use default name when not specified", async () => {
      const { host, protocol } = getTestWorkerHost();

      client = new AgentClient({
        agent: "TestStateAgent",
        host,
        protocol
      });

      await client.ready;

      expect(client.name).toBe("default");
    });

    it("should convert camelCase agent to kebab-case", async () => {
      const { host, protocol } = getTestWorkerHost();

      client = new AgentClient({
        agent: "TestStateAgent",
        name: "kebab-test",
        host,
        protocol
      });

      await client.ready;

      expect(client.agent).toBe("test-state-agent");
    });
  });

  describe("state synchronization", () => {
    it("should call onStateUpdate when client sends state", async () => {
      const { host, protocol } = getTestWorkerHost();
      const onStateUpdate = vi.fn();

      client = new AgentClient({
        agent: "TestStateAgent",
        name: "client-test-state-send",
        host,
        protocol,
        onStateUpdate
      });

      await client.ready;

      // Send a state update from the client
      const newState = { count: 42, items: ["test"], lastUpdated: Date.now() };
      client.setState(newState);

      // onStateUpdate should be called immediately with source "client"
      expect(onStateUpdate).toHaveBeenCalledWith(newState, "client");
    });

    it("should receive state broadcasts from server", async () => {
      const { host, protocol } = getTestWorkerHost();
      const onStateUpdate = vi.fn();

      client = new AgentClient({
        agent: "TestStateAgent",
        name: "client-test-state-recv",
        host,
        protocol,
        onStateUpdate
      });

      await client.ready;

      // Send a state update - the server will broadcast it back
      const newState = {
        count: 99,
        items: ["broadcast-test"],
        lastUpdated: Date.now()
      };
      client.setState(newState);

      // Wait for the server to broadcast the state back
      await vi.waitFor(
        () => {
          // Look for a "server" source call (the broadcast back from server)
          const serverCall = onStateUpdate.mock.calls.find(
            ([, source]) => source === "server"
          );
          expect(serverCall).toBeDefined();
        },
        { timeout: 5000 }
      );
    });
  });

  describe("RPC calls", () => {
    it("should call @callable methods and receive response", async () => {
      const { host, protocol } = getTestWorkerHost();

      client = new AgentClient({
        agent: "TestCallableAgent",
        name: "client-test-rpc",
        host,
        protocol
      });

      await client.ready;

      // TestCallableAgent has an 'add' method
      const result = await client.call<number>("add", [2, 3]);

      expect(result).toBe(5);
    });

    it("should handle RPC errors", async () => {
      const { host, protocol } = getTestWorkerHost();

      client = new AgentClient({
        agent: "TestCallableAgent",
        name: "client-test-rpc-error",
        host,
        protocol
      });

      await client.ready;

      // TestCallableAgent has a 'throwError' method that requires a message
      await expect(
        client.call("throwError", ["test error message"])
      ).rejects.toThrow();
    });

    it("should support RPC timeout", async () => {
      const { host, protocol } = getTestWorkerHost();

      client = new AgentClient({
        agent: "TestCallableAgent",
        name: "client-test-rpc-timeout",
        host,
        protocol
      });

      await client.ready;

      // Use asyncMethod with a delay, but with a very short timeout
      await expect(
        client.call("asyncMethod", [5000], { timeout: 10 })
      ).rejects.toThrow(/timed out/);
    });

    it("should handle streaming RPC responses", async () => {
      const { host, protocol } = getTestWorkerHost();
      const chunks: unknown[] = [];
      const onChunk = vi.fn((chunk) => chunks.push(chunk));
      const onDone = vi.fn();

      client = new AgentClient({
        agent: "TestCallableAgent",
        name: "client-test-rpc-stream",
        host,
        protocol
      });

      await client.ready;

      // TestCallableAgent has a 'streamNumbers' method
      const result = await client.call("streamNumbers", [3], {
        stream: { onChunk, onDone }
      });

      // onChunk should have been called for each intermediate chunk
      expect(onChunk.mock.calls.length).toBeGreaterThan(0);
      // onDone should have been called with the final result
      expect(onDone).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("should reject pending calls on connection close", async () => {
      const { host, protocol } = getTestWorkerHost();

      client = new AgentClient({
        agent: "TestCallableAgent",
        name: "client-test-rpc-close",
        host,
        protocol
      });

      await client.ready;

      // Start an async call that will take a while
      const callPromise = client.call("asyncMethod", [5000]);

      // Close the connection immediately - pending calls should reject immediately
      client.close();

      // The call should be rejected immediately (not waiting for WebSocket close handshake)
      await expect(callPromise).rejects.toThrow("Connection closed");
    });
  });

  describe("identity change detection", () => {
    it("should detect identity change on reconnect", async () => {
      const { host, protocol } = getTestWorkerHost();
      const onIdentityChange = vi.fn();

      // This test would require server-side routing that changes identity
      // For now, we just verify the callback is wired up correctly
      client = new AgentClient({
        agent: "TestStateAgent",
        name: "client-test-identity-change",
        host,
        protocol,
        onIdentityChange
      });

      await client.ready;

      // On first connect, onIdentityChange should not be called
      expect(onIdentityChange).not.toHaveBeenCalled();
    });
  });

  describe("agentFetch", () => {
    it("should make HTTP requests to agent endpoints", async () => {
      const { host, protocol } = getTestWorkerHost();

      const response = await agentFetch({
        agent: "TestStateAgent",
        name: "fetch-test",
        host,
        protocol: protocol === "ws" ? "http" : "https",
        path: "state" // No leading slash
      });

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data).toHaveProperty("state");
    });

    it("should support different HTTP methods", async () => {
      const { host, protocol } = getTestWorkerHost();

      const response = await agentFetch(
        {
          agent: "TestStateAgent",
          name: "fetch-method-test",
          host,
          protocol: protocol === "ws" ? "http" : "https",
          path: "echo" // No leading slash
        },
        {
          method: "POST",
          body: "test-body"
        }
      );

      expect(response.ok).toBe(true);
      const data = (await response.json()) as { method: string; body: string };
      expect(data.method).toBe("POST");
      expect(data.body).toBe("test-body");
    });

    it("should use basePath when provided", async () => {
      const { host, protocol } = getTestWorkerHost();

      const response = await agentFetch({
        agent: "ignored", // Should be ignored when basePath is set
        host,
        protocol: protocol === "ws" ? "http" : "https",
        basePath: "/agents/test-state-agent/basepath-test/state"
      });

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data).toHaveProperty("state");
    });
  });

  describe("setState server verification", () => {
    it("should persist state to server", async () => {
      const { host, protocol } = getTestWorkerHost();
      const instanceName = `state-persist-${Date.now()}`;

      client = new AgentClient({
        agent: "TestStateAgent",
        name: instanceName,
        host,
        protocol
      });

      await client.ready;

      // Send state update
      const newState = {
        count: 123,
        items: ["persisted"],
        lastUpdated: Date.now()
      };
      client.setState(newState);

      // Wait for server to process
      await new Promise((r) => setTimeout(r, 100));

      // Verify via HTTP that state was persisted
      const response = await agentFetch({
        agent: "TestStateAgent",
        name: instanceName,
        host,
        protocol: protocol === "ws" ? "http" : "https",
        path: "state"
      });

      const data = (await response.json()) as {
        state: { count: number; items: string[] };
      };
      expect(data.state.count).toBe(123);
      expect(data.state.items).toContain("persisted");
    });

    it("should track state updates on server", async () => {
      const { host, protocol } = getTestWorkerHost();
      const instanceName = `state-updates-${Date.now()}`;

      client = new AgentClient({
        agent: "TestStateAgent",
        name: instanceName,
        host,
        protocol
      });

      await client.ready;

      // Send multiple state updates
      client.setState({ count: 1, items: [], lastUpdated: Date.now() });
      client.setState({ count: 2, items: [], lastUpdated: Date.now() });

      // Wait for server to process
      await new Promise((r) => setTimeout(r, 200));

      // Verify server tracked the updates
      const response = await agentFetch({
        agent: "TestStateAgent",
        name: instanceName,
        host,
        protocol: protocol === "ws" ? "http" : "https",
        path: "state-updates"
      });

      const data = (await response.json()) as { updates: unknown[] };
      expect(data.updates.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("path option", () => {
    it("should connect to specific path within agent", async () => {
      const { host, protocol } = getTestWorkerHost();

      client = new AgentClient({
        agent: "TestStateAgent",
        name: "path-test",
        host,
        protocol,
        path: "custom-path" // No leading slash
      });

      // Should still connect and receive identity
      await client.ready;

      expect(client.identified).toBe(true);
    });
  });

  describe("multiple concurrent connections", () => {
    let client2: AgentClient | null = null;

    afterEach(() => {
      if (client2) {
        client2.close();
        client2 = null;
      }
    });

    it("should handle multiple clients to same agent instance", async () => {
      const { host, protocol } = getTestWorkerHost();
      const instanceName = `multi-client-${Date.now()}`;

      // Create first client
      client = new AgentClient({
        agent: "TestStateAgent",
        name: instanceName,
        host,
        protocol
      });

      await client.ready;

      // Create second client to same instance
      client2 = new AgentClient({
        agent: "TestStateAgent",
        name: instanceName,
        host,
        protocol
      });

      await client2.ready;

      // Both should be connected
      expect(client.identified).toBe(true);
      expect(client2.identified).toBe(true);

      // Verify via HTTP that both connections exist
      const response = await agentFetch({
        agent: "TestStateAgent",
        name: instanceName,
        host,
        protocol: protocol === "ws" ? "http" : "https",
        path: "connections"
      });

      const data = (await response.json()) as { count: number };
      expect(data.count).toBe(2);
    });

    it("should broadcast state updates to other clients", async () => {
      const { host, protocol } = getTestWorkerHost();
      const instanceName = `broadcast-${Date.now()}`;
      const client2Updates: Array<{ count: number }> = [];

      // Create first client (the sender)
      client = new AgentClient({
        agent: "TestStateAgent",
        name: instanceName,
        host,
        protocol
      });

      await client.ready;

      // Create second client (the receiver)
      client2 = new AgentClient({
        agent: "TestStateAgent",
        name: instanceName,
        host,
        protocol,
        onStateUpdate: (state, source) => {
          // Only track server broadcasts (not the sender's own updates)
          if (source === "server") {
            client2Updates.push(state as { count: number });
          }
        }
      });

      await client2.ready;

      // First client sends state - server will broadcast to client2 (not back to client1)
      const targetCount = 888;
      const newState = {
        count: targetCount,
        items: ["broadcast"],
        lastUpdated: Date.now()
      };
      client.setState(newState);

      // Wait for client2 to receive the broadcast
      await vi.waitFor(
        () => {
          const client2HasUpdate = client2Updates.some(
            (u) => u.count === targetCount
          );
          expect(client2HasUpdate).toBe(true);
        },
        { timeout: 5000 }
      );
    });
  });

  describe("reconnection behavior", () => {
    it("should reconnect after connection is closed", async () => {
      const { host, protocol } = getTestWorkerHost();
      const onOpen = vi.fn();
      const onClose = vi.fn();
      const onIdentity = vi.fn();

      client = new AgentClient({
        agent: "TestStateAgent",
        name: "reconnect-test",
        host,
        protocol,
        onIdentity
      });

      client.addEventListener("open", onOpen);
      client.addEventListener("close", onClose);

      await client.ready;
      expect(onIdentity).toHaveBeenCalledTimes(1);

      // Force a reconnect by calling reconnect()
      client.reconnect();

      // Wait for reconnection
      await vi.waitFor(
        () => {
          // Should have received identity again after reconnect
          expect(onIdentity.mock.calls.length).toBeGreaterThanOrEqual(2);
        },
        { timeout: 10000 }
      );

      expect(client.identified).toBe(true);
    });

    it("should re-identify after reconnection", async () => {
      const { host, protocol } = getTestWorkerHost();
      const identities: Array<{ name: string; agent: string }> = [];

      client = new AgentClient({
        agent: "TestStateAgent",
        name: "reidentify-test",
        host,
        protocol,
        onIdentity: (name, agent) => {
          identities.push({ name, agent });
        }
      });

      await client.ready;

      // Force reconnect
      client.reconnect();

      // Wait for re-identification
      await vi.waitFor(
        () => {
          expect(identities.length).toBeGreaterThanOrEqual(2);
        },
        { timeout: 10000 }
      );

      // All identities should be the same (same agent instance)
      expect(identities[0].name).toBe("reidentify-test");
      expect(identities[1].name).toBe("reidentify-test");
    });
  });

  describe("query parameters", () => {
    it("should pass query params in connection", async () => {
      const { host, protocol } = getTestWorkerHost();

      client = new AgentClient({
        agent: "TestStateAgent",
        name: "query-test",
        host,
        protocol,
        query: { token: "test-token", version: "1.0" }
      });

      // Should connect successfully with query params
      await client.ready;
      expect(client.identified).toBe(true);
    });

    it("should support async query function", async () => {
      const { host, protocol } = getTestWorkerHost();
      const queryFn = vi.fn(async () => ({
        token: "async-token"
      }));

      client = new AgentClient({
        agent: "TestStateAgent",
        name: "async-query-test",
        host,
        protocol,
        query: queryFn
      });

      await client.ready;

      expect(queryFn).toHaveBeenCalled();
      expect(client.identified).toBe(true);
    });
  });

  describe("basePath routing", () => {
    it("should connect via custom basePath", async () => {
      const { host, protocol } = getTestWorkerHost();

      client = new AgentClient({
        agent: "ignored",
        host,
        protocol,
        basePath: "/agents/test-state-agent/basepath-ws-test"
      });

      await client.ready;

      // Should connect and identify
      expect(client.identified).toBe(true);
      expect(client.name).toBe("basepath-ws-test");
    });
  });
});
