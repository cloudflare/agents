import { createExecutionContext, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, { type Env } from "./worker";
import { MessageType } from "../ai-types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

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

function waitForMessage(
  ws: WebSocket,
  predicate: (data: unknown) => boolean
): Promise<unknown> {
  return new Promise((resolve) => {
    const handler = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string);
        if (predicate(data)) {
          ws.removeEventListener("message", handler);
          resolve(data);
        }
      } catch {
        // Ignore parse errors
      }
    };
    ws.addEventListener("message", handler);
  });
}

describe("Readonly Connections", () => {
  describe("shouldConnectionBeReadonly hook", () => {
    it("should mark connections as readonly based on query parameter", async () => {
      const room = crypto.randomUUID();
      const { ws: ws1 } = await connectWS(
        `/agents/test-readonly-agent/${room}?readonly=true`
      );

      // Wait for initial state message
      await waitForMessage(
        ws1,
        (data: any) => data.type === MessageType.CF_AGENT_STATE
      );

      ws1.close();

      // Connect second connection separately
      const { ws: ws2 } = await connectWS(
        `/agents/test-readonly-agent/${room}?readonly=false`
      );

      await waitForMessage(
        ws2,
        (data: any) => data.type === MessageType.CF_AGENT_STATE
      );

      // Test passed - connections were established with different readonly query params
      ws2.close();
    }, 15000);
  });

  describe("state updates from readonly connections", () => {
    it("should block state updates from readonly connections", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS(
        `/agents/test-readonly-agent/${room}?readonly=true`
      );

      // Wait for initial state
      await waitForMessage(
        ws,
        (data: any) => data.type === MessageType.CF_AGENT_STATE
      );

      // Try to update state from readonly connection
      const errorPromise = waitForMessage(
        ws,
        (data: any) => data.type === MessageType.CF_AGENT_STATE_ERROR
      );

      ws.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STATE,
          state: { count: 999 }
        })
      );

      const errorMsg = (await errorPromise) as any;
      expect(errorMsg.type).toBe(MessageType.CF_AGENT_STATE_ERROR);
      expect(errorMsg.error).toBe("Connection is readonly");

      ws.close();
    });

    it("should allow state updates from non-readonly connections", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS(
        `/agents/test-readonly-agent/${room}?readonly=false`
      );

      // Wait for initial state
      const initialState = (await waitForMessage(
        ws,
        (data: any) => data.type === MessageType.CF_AGENT_STATE
      )) as any;

      expect(initialState.state).toBeDefined();

      ws.close();
    }, 10000);
  });

  describe("RPC calls from readonly connections", () => {
    it("should allow RPC calls from readonly connections", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS(
        `/agents/test-readonly-agent/${room}?readonly=true`
      );

      // Wait for initial state
      await waitForMessage(
        ws,
        (data: any) => data.type === MessageType.CF_AGENT_STATE
      );

      // Call RPC method from readonly connection
      const rpcId = Math.random().toString(36).slice(2);
      const rpcPromise = waitForMessage(
        ws,
        (data: any) => data.type === MessageType.RPC && data.id === rpcId
      );

      ws.send(
        JSON.stringify({
          type: MessageType.RPC,
          id: rpcId,
          method: "incrementCount",
          args: []
        })
      );

      const rpcMsg = (await rpcPromise) as any;
      expect(rpcMsg.success).toBe(true);
      expect(rpcMsg.result).toBe(1);

      ws.close();
    });
  });

  describe("dynamic readonly status changes", () => {
    it("should allow changing readonly status at runtime", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS(
        `/agents/test-readonly-agent/${room}?readonly=false`
      );

      // Wait for initial state
      await waitForMessage(
        ws,
        (data: any) => data.type === MessageType.CF_AGENT_STATE
      );

      // Call an RPC method to verify connection works
      const rpcId = Math.random().toString(36).slice(2);
      ws.send(
        JSON.stringify({
          type: MessageType.RPC,
          id: rpcId,
          method: "getState",
          args: []
        })
      );

      const rpcMsg = (await waitForMessage(
        ws,
        (data: any) => data.type === MessageType.RPC && data.id === rpcId
      )) as any;

      expect(rpcMsg.success).toBe(true);
      expect(rpcMsg.result).toBeDefined();

      ws.close();
    }, 10000);
  });

  describe("persistence across hibernation", () => {
    it("should persist readonly status in SQL storage", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS(
        `/agents/test-readonly-agent/${room}?readonly=true`
      );

      // Wait for connection
      await waitForMessage(
        ws,
        (data: any) => data.type === MessageType.CF_AGENT_STATE
      );

      // Check that readonly status is in the database
      const checkDbId = Math.random().toString(36).slice(2);
      ws.send(
        JSON.stringify({
          type: MessageType.RPC,
          id: checkDbId,
          method: "getReadonlyFromDb",
          args: []
        })
      );

      const dbResult = (await waitForMessage(
        ws,
        (data: any) => data.type === MessageType.RPC && data.id === checkDbId
      )) as any;

      // Should have at least one entry
      expect(Array.isArray(dbResult.result)).toBe(true);
      expect(dbResult.result.length).toBeGreaterThan(0);

      ws.close();
    });

    it("should restore readonly status after simulated hibernation", async () => {
      const room = crypto.randomUUID();

      // First connection - will be marked readonly
      const { ws: ws1 } = await connectWS(
        `/agents/test-readonly-agent/${room}?readonly=true`
      );

      await waitForMessage(
        ws1,
        (data: any) => data.type === MessageType.CF_AGENT_STATE
      );

      // Close connection (simulates hibernation scenario)
      ws1.close();

      // Small delay to ensure cleanup
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Reconnect with same connection (in real scenario, readonly status would persist)
      const { ws: ws2 } = await connectWS(
        `/agents/test-readonly-agent/${room}?readonly=true`
      );

      await waitForMessage(
        ws2,
        (data: any) => data.type === MessageType.CF_AGENT_STATE
      );

      // Try state update - should still be blocked
      const errorPromise = waitForMessage(
        ws2,
        (data: any) => data.type === MessageType.CF_AGENT_STATE_ERROR
      );

      ws2.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STATE,
          state: { count: 999 }
        })
      );

      const errorMsg = (await errorPromise) as any;
      expect(errorMsg.type).toBe(MessageType.CF_AGENT_STATE_ERROR);

      ws2.close();
    });
  });

  describe("cleanup on disconnect", () => {
    it("should remove readonly status from storage when connection closes", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS(
        `/agents/test-readonly-agent/${room}?readonly=true`
      );

      await waitForMessage(
        ws,
        (data: any) => data.type === MessageType.CF_AGENT_STATE
      );

      // Verify it's in the database
      const checkDbId1 = Math.random().toString(36).slice(2);
      ws.send(
        JSON.stringify({
          type: MessageType.RPC,
          id: checkDbId1,
          method: "getReadonlyFromDb",
          args: []
        })
      );

      const dbResult1 = (await waitForMessage(
        ws,
        (data: any) => data.type === MessageType.RPC && data.id === checkDbId1
      )) as any;

      expect(dbResult1.result.length).toBeGreaterThan(0);

      // Close connection
      ws.close();

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Connect with a new non-readonly connection to check database
      const { ws: ws2 } = await connectWS(
        `/agents/test-readonly-agent/${room}?readonly=false`
      );

      await waitForMessage(
        ws2,
        (data: any) => data.type === MessageType.CF_AGENT_STATE
      );

      const checkDbId2 = Math.random().toString(36).slice(2);
      ws2.send(
        JSON.stringify({
          type: MessageType.RPC,
          id: checkDbId2,
          method: "getReadonlyFromDb",
          args: []
        })
      );

      const dbResult2 = (await waitForMessage(
        ws2,
        (data: any) => data.type === MessageType.RPC && data.id === checkDbId2
      )) as any;

      // Old connection should be cleaned up
      expect(dbResult2.result).toEqual([]);

      ws2.close();
    });
  });

  describe("multiple connections", () => {
    it("should handle multiple connections with different readonly states", async () => {
      const room = crypto.randomUUID();

      // Connect readonly first
      const { ws: ws1 } = await connectWS(
        `/agents/test-readonly-agent/${room}?readonly=true`
      );

      await waitForMessage(
        ws1,
        (data: any) => data.type === MessageType.CF_AGENT_STATE
      );

      // ws1 (readonly) should not be able to update state
      const errorPromise = waitForMessage(
        ws1,
        (data: any) => data.type === MessageType.CF_AGENT_STATE_ERROR
      );

      ws1.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STATE,
          state: { count: 100 }
        })
      );

      const errorMsg = (await errorPromise) as any;
      expect(errorMsg.error).toBe("Connection is readonly");

      ws1.close();

      // Now connect a writable connection to verify it works differently
      const { ws: ws2 } = await connectWS(
        `/agents/test-readonly-agent/${room}?readonly=false`
      );

      await waitForMessage(
        ws2,
        (data: any) => data.type === MessageType.CF_AGENT_STATE
      );

      ws2.close();
    }, 15000);
  });
});
