import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";
import worker from "./worker";
import { getAgentByName } from "..";
import { MessageType } from "../types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Helper to connect WebSocket to an agent via custom path
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

// Helper to wait for identity message and return it
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

// Helper to wait for state message (skipping identity first)
async function waitForState(ws: WebSocket): Promise<unknown> {
  // Skip identity message
  await waitForIdentity(ws);
  // Get state message
  const msg = (await waitForMessage(ws)) as { type: string; state: unknown };
  expect(msg.type).toBe(MessageType.CF_AGENT_STATE);
  return msg.state;
}

describe("basePath routing", () => {
  describe("custom path with getAgentByName + fetch", () => {
    it("should route /custom-state/{name} to TestStateAgent instance", async () => {
      const instanceName = `basepath-test-${crypto.randomUUID()}`;

      // Connect via custom path
      const { ws } = await connectWS(`/custom-state/${instanceName}`);

      // Should receive initial state
      const state = await waitForState(ws);
      expect(state).toEqual({
        count: 0,
        items: [],
        lastUpdated: null
      });

      ws.close();
    });

    it("should share state when accessing same instance via custom path", async () => {
      const instanceName = `shared-state-${crypto.randomUUID()}`;

      // First, set some state via RPC
      const agentStub = await getAgentByName(env.TestStateAgent, instanceName);
      await agentStub.updateState({
        count: 42,
        items: ["test"],
        lastUpdated: "now"
      });

      // Connect via custom path - should see the updated state
      const { ws } = await connectWS(`/custom-state/${instanceName}`);

      const state = (await waitForState(ws)) as { count: number };
      expect(state.count).toBe(42);

      ws.close();
    });

    it("should route /user to auth-determined instance", async () => {
      // Set state on the "auth-user" instance that /user routes to
      const agentStub = await getAgentByName(env.TestStateAgent, "auth-user");
      await agentStub.updateState({
        count: 100,
        items: ["authenticated"],
        lastUpdated: "auth-test"
      });

      // Connect via /user - server determines instance from "auth"
      const { ws } = await connectWS("/user");

      const state = (await waitForState(ws)) as {
        count: number;
        items: string[];
      };
      expect(state.count).toBe(100);
      expect(state.items).toContain("authenticated");

      ws.close();
    });
  });

  describe("identity sync", () => {
    it("should receive correct identity for custom path with dynamic instance name", async () => {
      const instanceName = `identity-test-${crypto.randomUUID()}`;

      // Connect via custom path
      const { ws } = await connectWS(`/custom-state/${instanceName}`);

      // First message should be identity
      const identity = await waitForIdentity(ws);
      expect(identity.name).toBe(instanceName);
      expect(identity.agent).toBe("test-state-agent");

      ws.close();
    });

    it("should receive correct identity for /user path (server-determined instance)", async () => {
      // Connect via /user - server routes to "auth-user" instance
      const { ws } = await connectWS("/user");

      // First message should be identity with the server-determined name
      const identity = await waitForIdentity(ws);
      expect(identity.name).toBe("auth-user"); // Server determined this from "auth"
      expect(identity.agent).toBe("test-state-agent");

      ws.close();
    });

    it("should receive correct identity for default routing", async () => {
      const room = `identity-default-${crypto.randomUUID()}`;

      // Connect via standard agent path
      const { ws } = await connectWS(`/agents/test-state-agent/${room}`);

      // First message should be identity
      const identity = await waitForIdentity(ws);
      expect(identity.name).toBe(room);
      expect(identity.agent).toBe("test-state-agent");

      ws.close();
    });
  });

  describe("HTTP requests via custom path", () => {
    it.skip("should handle HTTP requests via custom path", async () => {
      // Note: HTTP requests via custom path work in production but have issues
      // in vitest cloudflare:test environment. WebSocket tests cover the main use case.
      // Make HTTP request to /user which is handled by custom routing
      const ctx = createExecutionContext();
      const req = new Request("http://example.com/user");
      const res = await worker.fetch(req, env, ctx);

      // Request should reach the agent (not get 404 from the worker)
      // The agent returns 426 for non-WebSocket upgrade required, or handles HTTP
      // Either way, it should NOT be 404 (which means the route wasn't matched)
      expect(res.status).not.toBe(404);
    });
  });

  describe("default routing still works", () => {
    it("should still route via /agents/{agent}/{name}", async () => {
      const room = `default-route-${crypto.randomUUID()}`;

      // Connect via standard agent path
      const { ws } = await connectWS(`/agents/test-state-agent/${room}`);

      // Skip identity, get state
      const state = await waitForState(ws);
      expect(state).toEqual({
        count: 0,
        items: [],
        lastUpdated: null
      });

      ws.close();
    });
  });

  describe("server identity opt-out (sendIdentityOnConnect: false)", () => {
    it("should NOT send identity when agent opts out", async () => {
      const room = `no-identity-${crypto.randomUUID()}`;

      // Connect to agent that has sendIdentityOnConnect: false
      const { ws } = await connectWS(`/agents/test-no-identity-agent/${room}`);

      // First message should be state, NOT identity
      const msg = (await waitForMessage(ws)) as { type: string };
      expect(msg.type).toBe(MessageType.CF_AGENT_STATE);

      ws.close();
    });

    it("should still send state when identity is opted out", async () => {
      const room = `no-identity-state-${crypto.randomUUID()}`;

      // Connect to agent that has sendIdentityOnConnect: false
      const { ws } = await connectWS(`/agents/test-no-identity-agent/${room}`);

      // First message should be state with initial values
      const msg = (await waitForMessage(ws)) as {
        type: string;
        state: { count: number };
      };
      expect(msg.type).toBe(MessageType.CF_AGENT_STATE);
      expect(msg.state.count).toBe(0);

      ws.close();
    });
  });
});
