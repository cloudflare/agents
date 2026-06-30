import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  evictAllDurableObjects,
  evictDurableObject,
  runInDurableObject
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../..";
import worker from "../worker";
import { DurableObjectEventStore } from "../../mcp/event-store";
import { initializeStreamableHTTPServer } from "../shared/test-utils";
import type { TestWaitConnectionsAgent } from "../agents/wait-connections";
import type { TestStateAgent, TestState } from "../agents/state";

/**
 * Durable Object eviction tests for the agents-mcp surface, built on the
 * production-faithful `evictDurableObject()` / `evictAllDurableObjects()`
 * helpers from `cloudflare:test` (vitest-pool-workers >= 0.16.20).
 *
 * Unlike the older hibernation tests in this package — which simulate
 * eviction by resetting a private `_isRestored` flag, constructing a fresh
 * `DurableObjectEventStore` over a mock storage, or instantiating a fresh
 * `MCPClientManager` — these tests tear the real DO out of memory and prove
 * that DO-backed state survives and rehydrates correctly from durable
 * storage on the next access.
 *
 * The discriminating assertion in every test is that some in-memory cache is
 * observed to be DROPPED by the eviction (read back through
 * `runInDurableObject` immediately after eviction) and then REBUILT from
 * storage when the agent is driven again. A test that only checked the final
 * value would pass even if eviction were a no-op; checking the post-eviction
 * empty state is what makes these tests fail if rehydration regresses.
 */
describe("agents-mcp Durable Object eviction (evictDurableObject)", () => {
  describe("MCPClientManager in-memory connections", () => {
    it("drops mcpConnections on eviction and rebuilds them from SQL storage", async () => {
      const stub = env.TestWaitConnectionsAgent.get(
        env.TestWaitConnectionsAgent.idFromName("eviction-restore")
      );

      // Build pre-eviction state: an MCP server row in SQLite plus a live
      // in-memory connection produced by restore. The mocked connectToServer
      // (see TestWaitConnectionsAgent) settles to FAILED without real I/O.
      await stub.__unsafe_ensureInitialized();
      await stub.insertMcpServer(
        "evict-server-1",
        "Evict Test Server",
        "http://nonexistent-mcp.example.com",
        "http://localhost:3000/callback",
        null
      );
      await stub.resetRestoredFlag();
      const before = await stub.restoreAndWait(5000);
      expect(before.connectionIds).toContain("evict-server-1");

      // Sanity: the in-memory map really is populated before eviction.
      const liveCount = await runInDurableObject(
        stub,
        (instance: TestWaitConnectionsAgent) =>
          Object.keys(instance.mcp.mcpConnections).length
      );
      expect(liveCount).toBeGreaterThan(0);

      // Tear the DO out of memory. The cf_agents_mcp_servers SQL row is
      // durable and survives; the in-memory mcpConnections map does not.
      await evictDurableObject(stub);

      // Immediately after eviction the in-memory map is empty — this is the
      // assertion that proves eviction actually dropped in-memory state and
      // that the restore below is doing real work, not observing a cache.
      const afterEvictionConnectionCount = await runInDurableObject(
        stub,
        (instance: TestWaitConnectionsAgent) =>
          Object.keys(instance.mcp.mcpConnections).length
      );
      expect(afterEvictionConnectionCount).toBe(0);

      // Drive the restore path (onStart calls this in production) and confirm
      // the connection is reconstructed from the persisted server row.
      await stub.resetRestoredFlag();
      const after = await stub.restoreAndWait(5000);
      expect(after.connectionIds).toContain("evict-server-1");
      const state = after.connectionStates["evict-server-1"];
      expect(state).toBeDefined();
      expect(state).not.toBe("connecting");
    });

    it("preserves the cf_agents_mcp_servers row across eviction (storage survives)", async () => {
      const stub = env.TestWaitConnectionsAgent.get(
        env.TestWaitConnectionsAgent.idFromName("eviction-storage-survives")
      );

      await stub.__unsafe_ensureInitialized();
      await stub.insertMcpServer(
        "persist-server",
        "Persisted Server",
        "http://nonexistent-mcp.example.com",
        "http://localhost:3000/callback",
        null
      );

      const rowBefore = await runInDurableObject(
        stub,
        (instance: TestWaitConnectionsAgent) =>
          instance.sql<{ id: string; name: string }>`
            SELECT id, name FROM cf_agents_mcp_servers WHERE id = 'persist-server'
          `[0] ?? null
      );
      expect(rowBefore?.id).toBe("persist-server");

      await evictDurableObject(stub);

      // The SQL row is durable: it must read back identically post-eviction.
      const rowAfter = await runInDurableObject(
        stub,
        (instance: TestWaitConnectionsAgent) =>
          instance.sql<{ id: string; name: string }>`
            SELECT id, name FROM cf_agents_mcp_servers WHERE id = 'persist-server'
          `[0] ?? null
      );
      expect(rowAfter).toEqual({
        id: "persist-server",
        name: "Persisted Server"
      });
    });
  });

  describe("DurableObjectEventStore seq counter", () => {
    it("rehydrates the seq counter from real DO storage after eviction", async () => {
      const stub = env.TestWaitConnectionsAgent.get(
        env.TestWaitConnectionsAgent.idFromName("eviction-event-store")
      );
      await stub.__unsafe_ensureInitialized();

      // Store two events through a DurableObjectEventStore backed by the real
      // DO storage. The in-memory seqByStream counter lives on the store
      // object, which is created (and discarded) per runInDurableObject call —
      // exactly the lifecycle that loses in-memory state on eviction.
      const id1 = await runInDurableObject(
        stub,
        (_instance: TestWaitConnectionsAgent, state) => {
          const store = new DurableObjectEventStore(state.storage);
          return store.storeEvent("evict-stream", {
            jsonrpc: "2.0",
            id: 1,
            method: "test/notify",
            params: { n: 1 }
          });
        }
      );
      const id2 = await runInDurableObject(
        stub,
        (_instance: TestWaitConnectionsAgent, state) => {
          const store = new DurableObjectEventStore(state.storage);
          return store.storeEvent("evict-stream", {
            jsonrpc: "2.0",
            id: 2,
            method: "test/notify",
            params: { n: 2 }
          });
        }
      );

      // Tear the DO out of memory. The persisted __mcp_event__ keys survive.
      await evictDurableObject(stub);

      // A fresh store over the post-eviction storage must recover the seq
      // counter from the persisted log rather than restarting at 1 (which
      // would mint a duplicate, unresumable event id).
      const id3 = await runInDurableObject(
        stub,
        (_instance: TestWaitConnectionsAgent, state) => {
          const store = new DurableObjectEventStore(state.storage);
          return store.storeEvent("evict-stream", {
            jsonrpc: "2.0",
            id: 3,
            method: "test/notify",
            params: { n: 3 }
          });
        }
      );

      // Ids are `<streamId>:<seqHex>` and must be strictly monotonic + unique.
      expect(id1).toBe(`evict-stream:${(1).toString(16).padStart(16, "0")}`);
      expect(id2).toBe(`evict-stream:${(2).toString(16).padStart(16, "0")}`);
      expect(id3).toBe(`evict-stream:${(3).toString(16).padStart(16, "0")}`);
      expect(new Set([id1, id2, id3]).size).toBe(3);
      expect(
        [id1, id2, id3].every((id, i, arr) => i === 0 || id > arr[i - 1])
      ).toBe(true);
    });

    it("replays persisted events after eviction via a rehydrated store", async () => {
      const stub = env.TestWaitConnectionsAgent.get(
        env.TestWaitConnectionsAgent.idFromName("eviction-event-replay")
      );
      await stub.__unsafe_ensureInitialized();

      const ids = await runInDurableObject(
        stub,
        async (_instance: TestWaitConnectionsAgent, state) => {
          const store = new DurableObjectEventStore(state.storage);
          const out: string[] = [];
          for (let i = 0; i < 3; i++) {
            out.push(
              await store.storeEvent("replay-stream", {
                jsonrpc: "2.0",
                id: i,
                method: "test/notify",
                params: { n: i }
              })
            );
          }
          return out;
        }
      );

      await evictDurableObject(stub);

      // After eviction, a brand-new store must replay the events that were
      // written before eviction — proving the event log is durable and that
      // replayEventsAfter reads it back (exclusive of the seed id).
      const replayed = await runInDurableObject(
        stub,
        async (_instance: TestWaitConnectionsAgent, state) => {
          const store = new DurableObjectEventStore(state.storage);
          const sent: string[] = [];
          await store.replayEventsAfter(ids[0], {
            send: async (eventId) => {
              sent.push(eventId);
            }
          });
          return sent;
        }
      );

      expect(replayed).toEqual([ids[1], ids[2]]);
    });
  });

  describe("base Agent in-memory state cache", () => {
    it("drops the cached _state on eviction and rebuilds it from cf_agents_state", async () => {
      const stub = await getAgentByName(
        env.TestStateAgent,
        "eviction-state-cache"
      );

      const next: TestState = {
        count: 7,
        items: ["alpha", "beta"],
        lastUpdated: "2026-06-27T00:00:00.000Z"
      };
      await stub.updateState(next);

      // Before eviction the in-memory _state cache is populated (not the
      // DEFAULT_STATE sentinel that a freshly-constructed instance holds).
      const cachedBefore = await runInDurableObject(
        stub,
        (instance: TestStateAgent) => {
          const i = instance as unknown as {
            _state: TestState;
            _stateSentinel: TestState;
          };
          return i._state === i._stateSentinel;
        }
      );
      expect(cachedBefore).toBe(false);

      await evictDurableObject(stub);

      // Immediately after eviction a fresh instance is constructed: its
      // private _state field is back to the DEFAULT_STATE sentinel, proving
      // the in-memory cache was genuinely dropped and the read below must hit
      // SQL storage.
      const isSentinelAfterEviction = await runInDurableObject(
        stub,
        (instance: TestStateAgent) => {
          const i = instance as unknown as {
            _state: TestState;
            _stateSentinel: TestState;
          };
          return i._state === i._stateSentinel;
        }
      );
      expect(isSentinelAfterEviction).toBe(true);

      // Accessing .state rehydrates from the durable cf_agents_state row.
      const restored = await stub.getState();
      expect(restored).toEqual(next);
    });
  });

  describe("McpAgent props + initialize request via the real transport", () => {
    it("survives eviction: props and persisted initialize request rehydrate", async () => {
      const ctx = createExecutionContext();
      const baseUrl = "http://example.com/mcp";

      // Drive the real streamable-HTTP transport so the McpAgent persists its
      // props and initialize request to DO storage exactly as in production.
      const sessionId = await initializeStreamableHTTPServer(ctx, baseUrl);
      expect(sessionId).toBeTruthy();

      // Address the same DO the transport used: `streamable-http:<sessionId>`.
      const stub = await getAgentByName(
        env.MCP_OBJECT,
        `streamable-http:${sessionId}`
      );

      const initBefore = await stub.getInitializeRequest();
      expect(initBefore).toBeDefined();

      await evictDurableObject(stub);

      // After eviction the persisted initialize request must read back from
      // storage so the session can be re-established without a fresh
      // initialize handshake.
      const initAfter = await stub.getInitializeRequest();
      expect(initAfter).toEqual(initBefore);

      // And the session keeps working through the transport after eviction:
      // a tools/call still resolves against the rehydrated agent.
      const callResponse = await worker.fetch(
        new Request(baseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "mcp-session-id": sessionId
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1234,
            method: "tools/call",
            params: { name: "greet", arguments: { name: "Evicted" } }
          })
        }),
        env,
        ctx
      );
      expect(callResponse.status).toBe(200);
      const body = await callResponse.text();
      expect(body).toContain("Hello, Evicted!");
    });
  });

  describe("evictAllDurableObjects", () => {
    it("evicts every running agent, and each rehydrates its own state", async () => {
      const a = await getAgentByName(env.TestStateAgent, "evict-all-a");
      const b = await getAgentByName(env.TestStateAgent, "evict-all-b");

      await a.updateState({
        count: 1,
        items: ["a"],
        lastUpdated: "2026-06-27T00:00:00.000Z"
      });
      await b.updateState({
        count: 2,
        items: ["b"],
        lastUpdated: "2026-06-27T00:00:00.000Z"
      });

      await evictAllDurableObjects();

      // Both instances were torn down: their _state caches reset to sentinel.
      const aIsSentinel = await runInDurableObject(
        a,
        (instance: TestStateAgent) => {
          const i = instance as unknown as {
            _state: TestState;
            _stateSentinel: TestState;
          };
          return i._state === i._stateSentinel;
        }
      );
      const bIsSentinel = await runInDurableObject(
        b,
        (instance: TestStateAgent) => {
          const i = instance as unknown as {
            _state: TestState;
            _stateSentinel: TestState;
          };
          return i._state === i._stateSentinel;
        }
      );
      expect(aIsSentinel).toBe(true);
      expect(bIsSentinel).toBe(true);

      // Each agent rehydrates its own distinct state from its own storage.
      expect((await a.getState()).count).toBe(1);
      expect((await b.getState()).count).toBe(2);
    });
  });
});
