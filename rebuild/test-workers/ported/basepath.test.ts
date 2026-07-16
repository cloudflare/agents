/**
 * Ported from ORIGINAL Agents:
 * - packages/agents/src/tests/basepath.test.ts
 * - port date: 2026-07-15
 * Modifications:
 * - Re-pointed `agents`/`MessageType` imports to `./compat.js`.
 * - Reuses the shared ported `TestStateAgent` fixture and worker-level
 *   `/custom-state/{name}` route; adds `/user` in the ported worker.
 * - `test-no-identity-agent` is backed by the rebuild's only available
 *   protocol suppression hook, which suppresses all protocol frames, not
 *   identity alone.
 */
// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName, MessageType } from "./compat.js";

const worker = (exports as { default: { fetch: typeof fetch } }).default;

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

async function waitForIdentity(
  ws: WebSocket
): Promise<{ name: string; agent: string }> {
  const msg = (await waitForMessage(ws)) as {
    type: string;
    name: string;
    agent: string;
  };
  expect(msg.type).toBe(MessageType.CF_AGENT_IDENTITY);
  return { name: msg.name, agent: msg.agent };
}

async function waitForState(ws: WebSocket): Promise<unknown> {
  await waitForIdentity(ws);
  const msg = (await waitForMessage(ws)) as { type: string; state: unknown };
  expect(msg.type).toBe(MessageType.CF_AGENT_STATE);
  return msg.state;
}

function closeAndWait(ws: WebSocket): Promise<void> {
  ws.close();
  return new Promise<void>((resolve) => setTimeout(resolve, 50));
}

describe("basePath routing (ported)", () => {
  describe("custom path with getAgentByName + fetch", () => {
    it("should route /custom-state/{name} to TestStateAgent instance", async () => {
      const instanceName = `basepath-test-${crypto.randomUUID()}`;

      const { ws } = await connectWS(`/custom-state/${instanceName}`);

      const state = await waitForState(ws);
      expect(state).toEqual({
        count: 0,
        items: [],
        lastUpdated: null
      });

      await closeAndWait(ws);
    });

    it("should share state when accessing same instance via custom path", async () => {
      const instanceName = `shared-state-${crypto.randomUUID()}`;

      const agentStub = await getAgentByName(env.TestStateAgent, instanceName);
      await agentStub.updateState({
        count: 42,
        items: ["test"],
        lastUpdated: "now"
      });

      const { ws } = await connectWS(`/custom-state/${instanceName}`);

      const state = (await waitForState(ws)) as { count: number };
      expect(state.count).toBe(42);

      await closeAndWait(ws);
    });

    it("should route /user to auth-determined instance", async () => {
      const agentStub = await getAgentByName(env.TestStateAgent, "auth-user");
      await agentStub.updateState({
        count: 100,
        items: ["authenticated"],
        lastUpdated: "auth-test"
      });

      const { ws } = await connectWS("/user");

      const state = (await waitForState(ws)) as {
        count: number;
        items: string[];
      };
      expect(state.count).toBe(100);
      expect(state.items).toContain("authenticated");

      await closeAndWait(ws);
    });
  });

  describe("identity sync", () => {
    it("should receive correct identity for custom path with dynamic instance name", async () => {
      const instanceName = `identity-test-${crypto.randomUUID()}`;

      const { ws } = await connectWS(`/custom-state/${instanceName}`);

      const identity = await waitForIdentity(ws);
      expect(identity.name).toBe(instanceName);
      expect(identity.agent).toBe("test-state-agent");

      await closeAndWait(ws);
    });

    it("should receive correct identity for /user path (server-determined instance)", async () => {
      const { ws } = await connectWS("/user");

      const identity = await waitForIdentity(ws);
      expect(identity.name).toBe("auth-user");
      expect(identity.agent).toBe("test-state-agent");

      await closeAndWait(ws);
    });

    it("should receive correct identity for default routing", async () => {
      const room = `identity-default-${crypto.randomUUID()}`;

      const { ws } = await connectWS(`/agents/test-state-agent/${room}`);

      const identity = await waitForIdentity(ws);
      expect(identity.name).toBe(room);
      expect(identity.agent).toBe("test-state-agent");

      await closeAndWait(ws);
    });
  });

  describe("HTTP requests via custom path", () => {
    it("forwards method + body through a custom path to the agent", async () => {
      const res = await worker.fetch("http://example.com/custom-state/echo", {
        method: "POST",
        body: "ping"
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        method: string;
        body: string;
        path: string;
      };
      expect(json).toEqual({ method: "POST", body: "ping", path: "echo" });
    });

    it("resolves a custom HTTP path to the same instance as RPC (shared state)", async () => {
      const agentStub = await getAgentByName(env.TestStateAgent, "state");
      await agentStub.updateState({
        count: 7,
        items: ["http"],
        lastUpdated: "d1"
      });

      const res = await worker.fetch("http://example.com/custom-state/state");
      expect(res.status).toBe(200);
      const json = (await res.json()) as { state: { count: number } };
      expect(json.state.count).toBe(7);
    });
  });

  describe("default routing still works", () => {
    it("should still route via /agents/{agent}/{name}", async () => {
      const room = `default-route-${crypto.randomUUID()}`;

      const { ws } = await connectWS(`/agents/test-state-agent/${room}`);

      const state = await waitForState(ws);
      expect(state).toEqual({
        count: 0,
        items: [],
        lastUpdated: null
      });

      await closeAndWait(ws);
    });
  });

  describe("server identity opt-out (sendIdentityOnConnect: false)", () => {
    it("should NOT send identity when agent opts out", async () => {
      const room = `no-identity-${crypto.randomUUID()}`;

      const { ws } = await connectWS(`/agents/test-no-identity-agent/${room}`);

      const msg = (await waitForMessage(ws)) as { type: string };
      expect(msg.type).toBe(MessageType.CF_AGENT_STATE);

      await closeAndWait(ws);
    });

    it("should still send state when identity is opted out", async () => {
      const room = `no-identity-state-${crypto.randomUUID()}`;

      const { ws } = await connectWS(`/agents/test-no-identity-agent/${room}`);

      const msg = (await waitForMessage(ws)) as {
        type: string;
        state: { count: number };
      };
      expect(msg.type).toBe(MessageType.CF_AGENT_STATE);
      expect(msg.state.count).toBe(0);

      await closeAndWait(ws);
    });
  });
});
