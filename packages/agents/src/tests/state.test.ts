/**
 * State Management Tests
 *
 * CODE REVIEW NOTES - Future improvements to address:
 *
 * SERVER-SIDE (packages/agents/src/index.ts):
 *
 * 1. State getter has side effects - The `get state()` accessor calls `setState()`
 *    on first access when initialState is defined. This triggers DB writes, broadcasts,
 *    and onStateUpdate. Consider lazy init that only caches locally without full setState flow.
 *
 * 2. DEFAULT_STATE sentinel pattern - Uses object identity (`===`) with `{}` sentinel.
 *    A Symbol('uninitialized') would be more explicit and safer.
 *
 * 3. SQL writes could be atomic - The STATE_ROW_ID and STATE_WAS_CHANGED writes in
 *    _setStateInternal could be combined into a single transaction.
 *
 * CLIENT-SIDE (packages/agents/src/client.ts & react.tsx):
 *
 * 4. No optimistic update confirmation - setState() immediately calls onStateUpdate
 *    before server confirmation. No way to know if update succeeded or rollback on failure.
 *
 * 5. No state getter on client - Clients can setState and receive onStateUpdate, but
 *    no getState() or state property. Users must track state themselves.
 *
 * 6. Silent failure on parse errors - Invalid JSON is silently swallowed with a TODO.
 *    Should log in development or provide onError callback.
 */

import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";
import worker from "./worker";
import { getAgentByName } from "..";
import { MessageType } from "../types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Helper to connect WebSocket to an agent
async function connectWS(path: string) {
  const ctx = createExecutionContext();
  const req = new Request(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  const res = await worker.fetch(req, env, ctx);
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws, ctx };
}

// Helper to wait for a WebSocket message
function waitForMessage(ws: WebSocket, timeout = 1000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for message")),
      timeout
    );
    ws.addEventListener(
      "message",
      (e: MessageEvent) => {
        clearTimeout(timer);
        resolve(JSON.parse(e.data as string));
      },
      { once: true }
    );
  });
}

describe("state management", () => {
  describe("initialState", () => {
    it("should return initialState on first access", async () => {
      const agentStub = await getAgentByName(
        env.TestStateAgent,
        "initial-state-test"
      );

      const state = await agentStub.getState();

      expect(state).toEqual({
        count: 0,
        items: [],
        lastUpdated: null
      });
    });

    it("should persist initialState to SQLite on first access", async () => {
      const agentStub = await getAgentByName(
        env.TestStateAgent,
        "initial-persist-test"
      );

      // First access triggers persistence
      await agentStub.getState();

      // Get a new stub (simulates restart) and verify state persisted
      const agentStub2 = await getAgentByName(
        env.TestStateAgent,
        "initial-persist-test"
      );
      const state = await agentStub2.getState();

      expect(state).toEqual({
        count: 0,
        items: [],
        lastUpdated: null
      });
    });

    it("should return undefined when no initialState defined", async () => {
      const agentStub = await getAgentByName(
        env.TestStateAgentNoInitial,
        "no-initial-test"
      );

      const state = await agentStub.getState();

      expect(state).toBeUndefined();
    });
  });

  describe("setState", () => {
    it("should update state immediately", async () => {
      const agentStub = await getAgentByName(
        env.TestStateAgent,
        "set-state-immediate-test"
      );

      const newState = {
        count: 42,
        items: ["a", "b", "c"],
        lastUpdated: "2024-01-01"
      };

      await agentStub.updateState(newState);
      const state = await agentStub.getState();

      expect(state).toEqual(newState);
    });

    it("should persist state to SQLite", async () => {
      const agentStub = await getAgentByName(
        env.TestStateAgent,
        "set-state-persist-test"
      );

      const newState = {
        count: 100,
        items: ["persisted"],
        lastUpdated: "2024-12-31"
      };

      await agentStub.updateState(newState);

      // Get new stub (simulates restart)
      const agentStub2 = await getAgentByName(
        env.TestStateAgent,
        "set-state-persist-test"
      );
      const state = await agentStub2.getState();

      expect(state).toEqual(newState);
    });

    it("should not reset to initialState on subsequent accesses", async () => {
      const agentStub = await getAgentByName(
        env.TestStateAgent,
        "no-reset-test"
      );

      // Set custom state
      const customState = {
        count: 999,
        items: ["custom"],
        lastUpdated: "custom"
      };
      await agentStub.updateState(customState);

      // Access state multiple times
      const state1 = await agentStub.getState();
      const state2 = await agentStub.getState();

      // Get new stub
      const agentStub2 = await getAgentByName(
        env.TestStateAgent,
        "no-reset-test"
      );
      const state3 = await agentStub2.getState();

      expect(state1).toEqual(customState);
      expect(state2).toEqual(customState);
      expect(state3).toEqual(customState);
    });
  });

  describe("onStateUpdate", () => {
    it("should be called when setState is invoked", async () => {
      const agentStub = await getAgentByName(
        env.TestStateAgent,
        "on-state-update-test"
      );

      await agentStub.clearStateUpdateCalls();

      const newState = {
        count: 1,
        items: ["test"],
        lastUpdated: "now"
      };
      await agentStub.updateState(newState);

      // onStateUpdate runs via waitUntil; poll until observed
      let calls: Array<{ state: unknown; source: string }> = [];
      const start = Date.now();
      while (calls.length === 0 && Date.now() - start < 500) {
        calls = await agentStub.getStateUpdateCalls();
        if (calls.length === 0) {
          await new Promise((r) => setTimeout(r, 10));
        }
      }

      expect(calls.length).toBe(1);
      expect(calls[0].state).toEqual(newState);
    });

    it("should receive 'server' as source when agent calls setState", async () => {
      const agentStub = await getAgentByName(
        env.TestStateAgent,
        "server-source-test"
      );

      await agentStub.clearStateUpdateCalls();

      await agentStub.updateState({
        count: 5,
        items: [],
        lastUpdated: null
      });

      // onStateUpdate runs via waitUntil; poll until observed
      let calls: Array<{ state: unknown; source: string }> = [];
      const start = Date.now();
      while (calls.length === 0 && Date.now() - start < 500) {
        calls = await agentStub.getStateUpdateCalls();
        if (calls.length === 0) {
          await new Promise((r) => setTimeout(r, 10));
        }
      }

      expect(calls.length).toBe(1);
      expect(calls[0].source).toBe("server");
    });
  });

  describe("client state sync", () => {
    it("should send current state to new connections", async () => {
      const room = `state-sync-${crypto.randomUUID()}`;

      // First set some state
      const agentStub = await getAgentByName(env.TestStateAgent, room);
      const customState = {
        count: 77,
        items: ["synced"],
        lastUpdated: "sync-test"
      };
      await agentStub.updateState(customState);

      // Now connect via WebSocket
      const { ws } = await connectWS(`/agents/test-state-agent/${room}`);

      // First message is identity, then state
      const identityMsg = (await waitForMessage(ws)) as { type: string };
      expect(identityMsg.type).toBe(MessageType.CF_AGENT_IDENTITY);

      const stateMsg = (await waitForMessage(ws)) as {
        type: string;
        state: unknown;
      };
      expect(stateMsg.type).toBe(MessageType.CF_AGENT_STATE);
      expect(stateMsg.state).toEqual(customState);

      ws.close();
    });

    it("should broadcast state to connected clients on setState", async () => {
      const room = `broadcast-${crypto.randomUUID()}`;

      // Connect via WebSocket first
      const { ws } = await connectWS(`/agents/test-state-agent/${room}`);

      // Collect all messages
      const messages: unknown[] = [];
      ws.addEventListener("message", (e: MessageEvent) => {
        messages.push(JSON.parse(e.data as string));
      });

      // Wait for initial messages
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Now update state from agent
      const agentStub = await getAgentByName(env.TestStateAgent, room);
      const newState = {
        count: 88,
        items: ["broadcast"],
        lastUpdated: "broadcast-test"
      };
      await agentStub.updateState(newState);

      // Wait for broadcast
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Find the broadcast message (should be after initial messages)
      const broadcastMsg = messages.find(
        (m) =>
          (m as { type: string; state?: { count?: number } }).type ===
            MessageType.CF_AGENT_STATE &&
          (m as { state?: { count?: number } }).state?.count === 88
      ) as { type: string; state: unknown } | undefined;

      expect(broadcastMsg).toBeDefined();
      expect(broadcastMsg?.state).toEqual(newState);

      ws.close();
    });

    it("should handle client-initiated state updates", async () => {
      const room = `client-update-${crypto.randomUUID()}`;

      // Connect via WebSocket
      const { ws } = await connectWS(`/agents/test-state-agent/${room}`);

      // Consume initial messages (identity, state, mcp_servers)
      await waitForMessage(ws);
      await waitForMessage(ws);
      await waitForMessage(ws);

      // Send state update from client (uses same CF_AGENT_STATE type)
      const clientState = {
        count: 123,
        items: ["from-client"],
        lastUpdated: "client-initiated"
      };
      ws.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STATE,
          state: clientState
        })
      );

      // Give time for update to process
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify state was updated
      const agentStub = await getAgentByName(env.TestStateAgent, room);
      const state = await agentStub.getState();

      expect(state).toEqual(clientState);

      ws.close();
    });
  });

  describe("state with no initialState agent", () => {
    it("should allow setting state when no initialState defined", async () => {
      const agentStub = await getAgentByName(
        env.TestStateAgentNoInitial,
        "set-when-no-initial-test"
      );

      // Initially undefined
      const initialState = await agentStub.getState();
      expect(initialState).toBeUndefined();

      // Set state
      const newState = { custom: "data", count: 42 };
      await agentStub.updateState(newState);

      // Verify set
      const state = await agentStub.getState();
      expect(state).toEqual(newState);
    });

    it("should persist state when no initialState defined", async () => {
      const agentStub = await getAgentByName(
        env.TestStateAgentNoInitial,
        "persist-no-initial-test"
      );

      const newState = { persisted: true };
      await agentStub.updateState(newState);

      // Get new stub
      const agentStub2 = await getAgentByName(
        env.TestStateAgentNoInitial,
        "persist-no-initial-test"
      );
      const state = await agentStub2.getState();

      expect(state).toEqual(newState);
    });
  });

  describe("error recovery", () => {
    it("should recover from corrupted state JSON by falling back to initialState", async () => {
      // Use a unique name so this agent hasn't accessed state yet
      const agentStub = await getAgentByName(
        env.TestStateAgent,
        `corrupted-state-test-${crypto.randomUUID()}`
      );

      // Insert corrupted state directly (before any state access)
      await agentStub.insertCorruptedState();

      // Access state - should trigger try-catch and recover to initialState
      const state = await agentStub.getStateAfterCorruption();

      // Should have recovered to initialState
      expect(state).toEqual({
        count: 0,
        items: [],
        lastUpdated: null
      });
    });
  });

  describe("validateStateChange validation", () => {
    it("should not broadcast state if validateStateChange throws", async () => {
      const room = `throwing-state-${crypto.randomUUID()}`;

      // Connect a WebSocket client first
      const { ws } = await connectWS(
        `/agents/test-throwing-state-agent/${room}`
      );

      // Collect all messages
      const messages: Array<{ type: string; state?: unknown }> = [];
      ws.addEventListener("message", (e: MessageEvent) => {
        messages.push(JSON.parse(e.data as string));
      });

      // Wait for initial messages (identity, state, mcp_servers)
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Clear messages to only capture new ones
      const initialCount = messages.length;

      // Get the agent stub and try to set invalid state (count = -1 triggers throw)
      const agentStub = await getAgentByName(env.TestThrowingStateAgent, room);

      // This should throw in validateStateChange (sync gate)
      try {
        await agentStub.updateState({
          count: -1,
          items: ["invalid"],
          lastUpdated: "should-not-broadcast"
        });
      } catch {
        // Expected to throw
      }

      // Wait a bit for any broadcast that might have happened
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Check that no new state messages were broadcast
      const newMessages = messages.slice(initialCount);
      const stateMessages = newMessages.filter(
        (m) => m.type === MessageType.CF_AGENT_STATE
      );

      // If onStateUpdate throws, state should NOT be broadcast
      expect(stateMessages.length).toBe(0);

      ws.close();
    });

    it("should broadcast state when validateStateChange succeeds", async () => {
      const room = `valid-state-${crypto.randomUUID()}`;

      // Connect a WebSocket client first
      const { ws } = await connectWS(
        `/agents/test-throwing-state-agent/${room}`
      );

      // Collect all messages
      const messages: Array<{ type: string; state?: { count?: number } }> = [];
      ws.addEventListener("message", (e: MessageEvent) => {
        messages.push(JSON.parse(e.data as string));
      });

      // Wait for initial messages
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Clear messages to only capture new ones
      const initialCount = messages.length;

      // Get the agent stub and set valid state
      const agentStub = await getAgentByName(env.TestThrowingStateAgent, room);

      await agentStub.updateState({
        count: 42,
        items: ["valid"],
        lastUpdated: "should-broadcast"
      });

      // Wait for broadcast
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have received a state broadcast
      const newMessages = messages.slice(initialCount);
      const stateMessages = newMessages.filter(
        (m) => m.type === MessageType.CF_AGENT_STATE
      );

      expect(stateMessages.length).toBe(1);
      expect(stateMessages[0].state?.count).toBe(42);

      ws.close();
    });

    it("should still broadcast state even if onStateUpdate throws", async () => {
      const room = `on-state-update-throws-${crypto.randomUUID()}`;

      // Connect a WebSocket client first
      const { ws } = await connectWS(
        `/agents/test-throwing-state-agent/${room}`
      );

      // Collect all messages
      const messages: Array<{ type: string; state?: { count?: number } }> = [];
      ws.addEventListener("message", (e: MessageEvent) => {
        messages.push(JSON.parse(e.data as string));
      });

      // Wait for initial messages
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Clear messages to only capture new ones
      const initialCount = messages.length;

      const agentStub = await getAgentByName(env.TestThrowingStateAgent, room);
      await agentStub.clearOnErrorCalls();

      // This triggers onStateUpdate to throw (count === -2) but should not block broadcast
      await agentStub.updateState({
        count: -2,
        items: ["still-broadcast"],
        lastUpdated: "onStateUpdate-throws"
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      const newMessages = messages.slice(initialCount);
      const stateMessages = newMessages.filter(
        (m) => m.type === MessageType.CF_AGENT_STATE
      );

      expect(stateMessages.length).toBe(1);
      expect(stateMessages[0].state?.count).toBe(-2);

      // Error should have been routed through onError (best-effort)
      const errors = await agentStub.getOnErrorCalls();
      expect(errors.some((e) => e.includes("onStateUpdate failed"))).toBe(true);

      ws.close();
    });

    it("should send CF_AGENT_STATE_ERROR to client when validateStateChange rejects a client-originated update", async () => {
      const room = `validate-client-${crypto.randomUUID()}`;

      const { ws } = await connectWS(
        `/agents/test-throwing-state-agent/${room}`
      );

      // Wait for initial messages (identity, state, mcp_servers)
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Collect messages going forward
      const messages: Array<{ type: string; error?: string; state?: unknown }> =
        [];
      ws.addEventListener("message", (e: MessageEvent) => {
        messages.push(JSON.parse(e.data as string));
      });

      // Send invalid state from the client (count: -1 triggers validateStateChange throw)
      ws.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STATE,
          state: { count: -1, items: ["invalid"], lastUpdated: "client" }
        })
      );

      // Wait for the error response
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should have received a CF_AGENT_STATE_ERROR
      const errorMessages = messages.filter(
        (m) => m.type === MessageType.CF_AGENT_STATE_ERROR
      );
      expect(errorMessages.length).toBe(1);
      expect(errorMessages[0].error).toBe("State update rejected");

      // Should NOT have received a state broadcast (the update was rejected)
      const stateMessages = messages.filter(
        (m) => m.type === MessageType.CF_AGENT_STATE
      );
      expect(stateMessages.length).toBe(0);

      ws.close();
    });

    it("should send state broadcast (not error) for valid client-originated updates", async () => {
      const room = `validate-client-valid-${crypto.randomUUID()}`;

      const { ws } = await connectWS(
        `/agents/test-throwing-state-agent/${room}`
      );

      // Wait for initial messages
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Collect messages going forward
      const messages: Array<{ type: string; state?: { count?: number } }> = [];
      ws.addEventListener("message", (e: MessageEvent) => {
        messages.push(JSON.parse(e.data as string));
      });

      // Send valid state from the client
      ws.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STATE,
          state: { count: 10, items: ["valid"], lastUpdated: "client" }
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should NOT have received an error
      const errorMessages = messages.filter(
        (m) => m.type === MessageType.CF_AGENT_STATE_ERROR
      );
      expect(errorMessages.length).toBe(0);

      ws.close();
    });
  });

  describe("onStateChanged hook", () => {
    it("should call onStateChanged after setState (server-side)", async () => {
      const room = `persisted-hook-${crypto.randomUUID()}`;
      const agentStub = await getAgentByName(env.TestPersistedStateAgent, room);

      await agentStub.clearPersistedCalls();

      await agentStub.updateState({
        count: 7,
        items: ["persisted"],
        lastUpdated: "server"
      });

      // onStateChanged runs via waitUntil; poll until observed
      let calls: Array<{ state: unknown; source: string }> = [];
      const start = Date.now();
      while (Date.now() - start < 2000) {
        calls = await agentStub.getPersistedCalls();
        if (calls.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(calls.length).toBeGreaterThanOrEqual(1);
      const last = calls[calls.length - 1];
      expect(last.source).toBe("server");
      expect((last.state as { count: number }).count).toBe(7);
    });

    it("should call onStateChanged with connection source for client-originated updates", async () => {
      const room = `persisted-hook-client-${crypto.randomUUID()}`;

      const { ws } = await connectWS(
        `/agents/test-persisted-state-agent/${room}`
      );

      // Wait for initial messages
      await new Promise((resolve) => setTimeout(resolve, 100));

      const agentStub = await getAgentByName(env.TestPersistedStateAgent, room);
      await agentStub.clearPersistedCalls();

      // Send state update from client
      ws.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STATE,
          state: { count: 99, items: ["from-client"], lastUpdated: "client" }
        })
      );

      // Poll for the hook to fire
      let calls: Array<{ state: unknown; source: string }> = [];
      const start = Date.now();
      while (Date.now() - start < 2000) {
        calls = await agentStub.getPersistedCalls();
        if (calls.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(calls.length).toBeGreaterThanOrEqual(1);
      const last = calls[calls.length - 1];
      // Source should be a connection ID (not "server")
      expect(last.source).not.toBe("server");
      expect((last.state as { count: number }).count).toBe(99);

      ws.close();
    });

    it("should throw if both onStateUpdate and onStateChanged are overridden on the same class", async () => {
      const room = `both-hooks-${crypto.randomUUID()}`;
      const agentStub = await getAgentByName(env.TestBothHooksAgent, room);

      // Calling setState triggers _callStatePersistenceHook, which should throw
      let threw = false;
      let errorMessage = "";
      try {
        await agentStub.updateState({
          count: 1,
          items: [],
          lastUpdated: null
        });
      } catch (e) {
        threw = true;
        errorMessage = e instanceof Error ? e.message : String(e);
      }
      expect(threw).toBe(true);
      expect(errorMessage).toContain(
        "Cannot override both onStateChanged and onStateUpdate"
      );
    });
  });
});
