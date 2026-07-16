/**
 * Ported from ORIGINAL Agents:
 * - packages/agents/src/tests/state.test.ts
 * - port date: 2026-07-15
 * Modifications:
 * - Re-pointed `agents`/`MessageType` imports to `./compat.js`.
 * - Re-authored state fixtures against rebuild `Think` + hostAgent.
 * - Dropped native-covered state container behavior with pointers.
 * - Kept WebSocket/client-origin validation probes as [fidelity:adapter].
 */
// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName, MessageType } from "./compat.js";
import type {
  TestP12PersistedStateAgent,
  TestP12State,
  TestP12StateAgent,
  TestP12StateAgentNoInitial,
  TestP12ThrowingStateAgent
} from "./fixtures/p12-state-agents.js";

const worker = (exports as { default: { fetch: typeof fetch } }).default;
const p12Env = env as unknown as {
  TestP12StateAgent: DurableObjectNamespace<TestP12StateAgent>;
  TestP12StateAgentNoInitial: DurableObjectNamespace<TestP12StateAgentNoInitial>;
  TestP12ThrowingStateAgent: DurableObjectNamespace<TestP12ThrowingStateAgent>;
  TestP12PersistedStateAgent: DurableObjectNamespace<TestP12PersistedStateAgent>;
};

function uniqueRoom(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function connectWS(path: string): Promise<{ ws: WebSocket }> {
  const res = await worker.fetch(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws };
}

function parseMessage(e: MessageEvent): {
  type?: string;
  state?: unknown;
  error?: string;
} {
  return JSON.parse(e.data as string) as {
    type?: string;
    state?: unknown;
    error?: string;
  };
}

function waitForMessage(
  ws: WebSocket,
  predicate: (msg: {
    type?: string;
    state?: unknown;
    error?: string;
  }) => boolean,
  timeout = 2000
): Promise<{ type?: string; state?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error("Timeout waiting for message"));
    }, timeout);
    const handler = (e: MessageEvent) => {
      const msg = parseMessage(e);
      if (!predicate(msg)) return;
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
      resolve(msg);
    };
    ws.addEventListener("message", handler);
  });
}

function collectMessages(ws: WebSocket, durationMs = 150): Promise<unknown[]> {
  return new Promise((resolve) => {
    const messages: unknown[] = [];
    const handler = (e: MessageEvent) => {
      messages.push(JSON.parse(e.data as string));
    };
    ws.addEventListener("message", handler);
    setTimeout(() => {
      ws.removeEventListener("message", handler);
      resolve(messages);
    }, durationMs);
  });
}

async function stateAgent(
  room: string
): Promise<DurableObjectStub<TestP12StateAgent>> {
  return getAgentByName(p12Env.TestP12StateAgent, room);
}

describe("state management (ported)", () => {
  describe("initialState", () => {
    it.skip("should return initialState on first access", () => {});
    // dropped: native src/domain/runtime/state/state.test.ts — initialState fallback is asserted.

    it.skip("should persist initialState to SQLite on first access", () => {});
    // dropped: native src/domain/runtime/state/state.test.ts — state persistence across containers over the same store is asserted.

    it.skip("should return undefined when no initialState defined", () => {});
    // dropped: native src/domain/runtime/state/state.test.ts — no persisted state and no initialState throws/has no initialized state in rebuild semantics.
  });

  describe("setState", () => {
    it.skip("should update state immediately", () => {});
    // dropped: native src/domain/runtime/state/state.test.ts — set updates the current state.

    it.skip("should persist state to SQLite", () => {});
    // dropped: native src/domain/runtime/state/state.test.ts — state persists so a second container sees it.

    it.skip("should not reset to initialState on subsequent accesses", () => {});
    // dropped: native src/domain/runtime/state/state.test.ts — persisted state overrides initialState.
  });

  describe("onStateChanged callback", () => {
    it.skip("should be called when setState is invoked", () => {});
    // dropped: native src/domain/runtime/state/state.test.ts — onChanged fires when state changes.

    it.skip("should receive 'server' as source when agent calls setState", () => {});
    // dropped: native src/domain/runtime/state/state.test.ts — omitted source defaults to server.
  });

  describe("client state sync", () => {
    it("should send current state to new connections", async () => {
      const room = uniqueRoom("state-sync");
      const customState: TestP12State = {
        count: 77,
        items: ["synced"],
        lastUpdated: "sync-test"
      };
      await (await stateAgent(room)).updateState(customState);

      const { ws } = await connectWS(`/agents/test-p12-state-agent/${room}`);

      const identityMsg = await waitForMessage(
        ws,
        (msg) => msg.type === MessageType.CF_AGENT_IDENTITY
      );
      expect(identityMsg.type).toBe(MessageType.CF_AGENT_IDENTITY);

      const stateMsg = await waitForMessage(
        ws,
        (msg) => msg.type === MessageType.CF_AGENT_STATE
      );
      expect(stateMsg.state).toEqual(customState);

      ws.close();
    });

    it("should broadcast state to connected clients on setState", async () => {
      const room = uniqueRoom("broadcast");
      const { ws } = await connectWS(`/agents/test-p12-state-agent/${room}`);
      await waitForMessage(
        ws,
        (msg) => msg.type === MessageType.CF_AGENT_STATE
      );

      const newState: TestP12State = {
        count: 88,
        items: ["broadcast"],
        lastUpdated: "broadcast-test"
      };
      // Original semantics: the listener is armed BEFORE the mutation (the
      // original attached a persistent collector first) — arming after the
      // RPC resolves races frame delivery and can drop the broadcast.
      const broadcastPromise = waitForMessage(
        ws,
        (msg) =>
          msg.type === MessageType.CF_AGENT_STATE &&
          (msg.state as { count?: number } | undefined)?.count === 88
      );
      await (await stateAgent(room)).updateState(newState);

      const broadcastMsg = await broadcastPromise;
      expect(broadcastMsg.state).toEqual(newState);
      ws.close();
    });

    it("should handle client-initiated state updates", async () => {
      const room = uniqueRoom("client-update");
      const { ws } = await connectWS(`/agents/test-p12-state-agent/${room}`);
      await waitForMessage(
        ws,
        (msg) => msg.type === MessageType.CF_AGENT_STATE
      );

      const clientState: TestP12State = {
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

      // Original semantics: no echo assertion — the original slept 50ms and
      // verified via RPC getState (state broadcasts are origin-excluded, so
      // waiting for an echo on the SAME socket can never succeed).
      await new Promise((resolve) => setTimeout(resolve, 50));

      const state = await (await stateAgent(room)).getState();
      expect(state).toEqual(clientState);
      ws.close();
    });
  });

  describe("state with no initialState agent", () => {
    it.skip("should allow setting state when no initialState defined", () => {});
    // dropped: native src/domain/runtime/state/state.test.ts — empty store can accept a later set.

    it.skip("should persist state when no initialState defined", () => {});
    // dropped: native src/domain/runtime/state/state.test.ts — set state persists independently of initialState.
  });

  describe("error recovery", () => {
    it.skip("should recover from corrupted state JSON by falling back to initialState", () => {});
    // dropped: native src/domain/runtime/state/state.test.ts — old SQL JSON corruption path is not present in rebuild's typed store state container.
  });

  describe("validateStateChange validation", () => {
    it("should not broadcast state if validateStateChange throws", async () => {
      const room = uniqueRoom("throwing-state");
      const { ws } = await connectWS(
        `/agents/test-p12-throwing-state-agent/${room}`
      );
      await waitForMessage(
        ws,
        (msg) => msg.type === MessageType.CF_AGENT_STATE
      );
      const initialCount = (await collectMessages(ws)).length;

      const agentStub = await getAgentByName(
        p12Env.TestP12ThrowingStateAgent,
        room
      );
      try {
        await agentStub.updateState({
          count: -1,
          items: ["invalid"],
          lastUpdated: "should-not-broadcast"
        });
      } catch {
        // Expected to throw.
      }

      const newMessages = (await collectMessages(ws)).slice(initialCount);
      const stateMessages = newMessages.filter(
        (m) =>
          typeof m === "object" &&
          m !== null &&
          (m as { type?: string }).type === MessageType.CF_AGENT_STATE
      );
      expect(stateMessages.length).toBe(0);
      ws.close();
    });

    it("should broadcast state when validateStateChange succeeds", async () => {
      const room = uniqueRoom("valid-state");
      const { ws } = await connectWS(
        `/agents/test-p12-throwing-state-agent/${room}`
      );
      await waitForMessage(
        ws,
        (msg) => msg.type === MessageType.CF_AGENT_STATE
      );

      const agentStub = await getAgentByName(
        p12Env.TestP12ThrowingStateAgent,
        room
      );
      // Listener armed before the mutation (original attached collector first).
      const stateMsgPromise = waitForMessage(
        ws,
        (msg) =>
          msg.type === MessageType.CF_AGENT_STATE &&
          (msg.state as { count?: number } | undefined)?.count === 42
      );
      await agentStub.updateState({
        count: 42,
        items: ["valid"],
        lastUpdated: "should-broadcast"
      });

      const stateMsg = await stateMsgPromise;
      expect((stateMsg.state as { count: number }).count).toBe(42);
      ws.close();
    });

    it("should still broadcast state even if onStateChanged throws", async () => {
      const room = uniqueRoom("on-state-changed-throws");
      const { ws } = await connectWS(
        `/agents/test-p12-throwing-state-agent/${room}`
      );
      await waitForMessage(
        ws,
        (msg) => msg.type === MessageType.CF_AGENT_STATE
      );

      const agentStub = await getAgentByName(
        p12Env.TestP12ThrowingStateAgent,
        room
      );
      await agentStub.clearOnErrorCalls();

      await agentStub.updateState({
        count: -2,
        items: ["still-broadcast"],
        lastUpdated: "onStateChanged-throws"
      });

      const stateMsg = await waitForMessage(
        ws,
        (msg) =>
          msg.type === MessageType.CF_AGENT_STATE &&
          (msg.state as { count?: number } | undefined)?.count === -2
      );
      expect((stateMsg.state as { count: number }).count).toBe(-2);

      const errors = await agentStub.getOnErrorCalls();
      expect(errors.some((e) => e.includes("onStateChanged failed"))).toBe(
        true
      );
      ws.close();
    });

    it("should send CF_AGENT_STATE_ERROR to client when validateStateChange rejects a client-originated update", async () => {
      const room = uniqueRoom("validate-client");
      const { ws } = await connectWS(
        `/agents/test-p12-throwing-state-agent/${room}`
      );
      await waitForMessage(
        ws,
        (msg) => msg.type === MessageType.CF_AGENT_STATE
      );

      ws.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STATE,
          state: { count: -1, items: ["invalid"], lastUpdated: "client" }
        })
      );

      const errorMsg = await waitForMessage(
        ws,
        (msg) => msg.type === MessageType.CF_AGENT_STATE_ERROR
      );
      expect(errorMsg.error).toBe("State update rejected");
      ws.close();
    });

    it("should send state broadcast (not error) for valid client-originated updates", async () => {
      const room = uniqueRoom("validate-client-valid");
      const { ws } = await connectWS(
        `/agents/test-p12-throwing-state-agent/${room}`
      );
      await waitForMessage(
        ws,
        (msg) => msg.type === MessageType.CF_AGENT_STATE
      );

      ws.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STATE,
          state: { count: 10, items: ["valid"], lastUpdated: "client" }
        })
      );

      const messages = await collectMessages(ws, 250);
      const errorMessages = messages.filter(
        (m) =>
          typeof m === "object" &&
          m !== null &&
          (m as { type?: string }).type === MessageType.CF_AGENT_STATE_ERROR
      );
      expect(errorMessages.length).toBe(0);
      ws.close();
    });
  });

  describe("onStateChanged hook", () => {
    it.skip("should call onStateChanged after setState (server-side)", () => {});
    // dropped: native src/domain/runtime/state/state.test.ts — onChanged receives server source for server-side set.

    it("should call onStateChanged with connection source for client-originated updates", async () => {
      const room = uniqueRoom("persisted-hook-client");
      const { ws } = await connectWS(
        `/agents/test-p12-persisted-state-agent/${room}`
      );
      await waitForMessage(
        ws,
        (msg) => msg.type === MessageType.CF_AGENT_STATE
      );

      const agentStub = await getAgentByName(
        p12Env.TestP12PersistedStateAgent,
        room
      );
      await agentStub.clearPersistedCalls();

      ws.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STATE,
          state: { count: 99, items: ["from-client"], lastUpdated: "client" }
        })
      );

      let calls: Array<{ state: unknown; source: string }> = [];
      const start = Date.now();
      while (Date.now() - start < 2000) {
        calls = await agentStub.getPersistedCalls();
        if (calls.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(calls.length).toBeGreaterThanOrEqual(1);
      const last = calls[calls.length - 1];
      expect(last.source).not.toBe("server");
      expect((last.state as { count: number }).count).toBe(99);
      ws.close();
    });

    it("should throw if both onStateUpdate and onStateChanged are overridden on the same class", async () => {
      const room = uniqueRoom("both-hooks");
      let threw = false;
      let errorMessage = "";
      try {
        const agentStub = await getAgentByName(
          (
            env as unknown as {
              TestP12BothHooksAgent: DurableObjectNamespace<{
                updateState(state: TestP12State): Promise<void>;
              }>;
            }
          ).TestP12BothHooksAgent,
          room
        );
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
