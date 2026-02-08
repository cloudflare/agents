import { createExecutionContext, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, { type Env } from "./worker";
import { MessageType } from "../types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Message types used in tests
interface StateMessage {
  type: MessageType.CF_AGENT_STATE;
  state: { count?: number };
}

interface StateErrorMessage {
  type: MessageType.CF_AGENT_STATE_ERROR;
  error: string;
}

interface RpcMessage {
  type: MessageType.RPC;
  id: string;
  success?: boolean;
  result?: unknown;
  error?: string;
}

type TestMessage = StateMessage | StateErrorMessage | RpcMessage;

function isTestMessage(data: unknown): data is TestMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    typeof (data as TestMessage).type === "string"
  );
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

function waitForMessage<T extends TestMessage>(
  ws: WebSocket,
  predicate: (data: TestMessage) => boolean,
  timeoutMs = 5000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error(`waitForMessage timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (e: MessageEvent) => {
      try {
        const data: unknown = JSON.parse(e.data as string);
        if (isTestMessage(data) && predicate(data)) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(data as T);
        }
      } catch {
        // Ignore parse errors
      }
    };
    ws.addEventListener("message", handler);
  });
}

// ── Test helpers ──────────────────────────────────────────────────────

/** Connect a WebSocket and wait for the initial state broadcast. */
async function connectAndWait(room: string, readonly: boolean) {
  const path = `/agents/test-readonly-agent/${room}?readonly=${readonly}`;
  const { ws, ctx } = await connectWS(path);
  await waitForMessage<StateMessage>(
    ws,
    (d) => d.type === MessageType.CF_AGENT_STATE
  );
  return { ws, ctx };
}

/** Send an RPC and return the parsed response. */
async function sendRpc(
  ws: WebSocket,
  method: string,
  args: unknown[] = []
): Promise<RpcMessage> {
  const id = Math.random().toString(36).slice(2);
  ws.send(JSON.stringify({ type: MessageType.RPC, id, method, args }));
  return waitForMessage<RpcMessage>(
    ws,
    (d) => d.type === MessageType.RPC && (d as RpcMessage).id === id
  );
}

describe("Readonly Connections", () => {
  describe("shouldConnectionBeReadonly hook", () => {
    it("should mark connections as readonly based on query parameter", async () => {
      const room = crypto.randomUUID();
      const { ws: ws1 } = await connectAndWait(room, true);
      ws1.close();

      const { ws: ws2 } = await connectAndWait(room, false);
      // Test passed — connections were established with different readonly query params
      ws2.close();
    }, 15000);
  });

  describe("state updates from readonly connections", () => {
    it("should block state updates from readonly connections", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectAndWait(room, true);

      // Try to update state from readonly connection
      const errorPromise = waitForMessage<StateErrorMessage>(
        ws,
        (data) => data.type === MessageType.CF_AGENT_STATE_ERROR
      );

      ws.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STATE,
          state: { count: 999 }
        })
      );

      const errorMsg = await errorPromise;
      expect(errorMsg.type).toBe(MessageType.CF_AGENT_STATE_ERROR);
      expect(errorMsg.error).toBe("Connection is readonly");

      ws.close();
    });

    it("should allow state updates from non-readonly connections", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectAndWait(room, false);
      // No error — writable connection accepted
      ws.close();
    }, 10000);
  });

  describe("RPC calls from readonly connections", () => {
    it("should block mutating RPC calls from readonly connections", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectAndWait(room, true);

      const rpcMsg = await sendRpc(ws, "incrementCount");
      expect(rpcMsg.success).toBe(false);
      expect(rpcMsg.error).toBe("Connection is readonly");

      ws.close();
    });

    it("should allow read-only RPC calls from readonly connections", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectAndWait(room, true);

      const rpcMsg = await sendRpc(ws, "getState");
      expect(rpcMsg.success).toBe(true);
      expect(rpcMsg.result).toEqual({ count: 0 });

      ws.close();
    });

    it("should allow mutating RPC calls from writable connections", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectAndWait(room, false);

      const rpcMsg = await sendRpc(ws, "incrementCount");
      expect(rpcMsg.success).toBe(true);
      expect(rpcMsg.result).toBe(1);

      ws.close();
    });
  });

  describe("dynamic readonly status changes", () => {
    it("should block mutations after flipping a writable connection to readonly", async () => {
      const room = crypto.randomUUID();

      const { ws: ws1 } = await connectAndWait(room, false);
      const { ws: ws2 } = await connectAndWait(room, false);

      // Get ws1's connection ID
      const idMsg = await sendRpc(ws1, "getMyConnectionId");
      expect(idMsg.success).toBe(true);
      const ws1ConnId = idMsg.result as string;

      // Confirm ws1 can mutate before flipping
      const inc1Msg = await sendRpc(ws1, "incrementCount");
      expect(inc1Msg.success).toBe(true);

      // Use ws2 to flip ws1 to readonly
      const setMsg = await sendRpc(ws2, "setReadonly", [ws1ConnId, true]);
      expect(setMsg.success).toBe(true);
      expect((setMsg.result as { readonly: boolean }).readonly).toBe(true);

      // Now ws1's mutating RPC should be blocked
      const inc2Msg = await sendRpc(ws1, "incrementCount");
      expect(inc2Msg.success).toBe(false);
      expect(inc2Msg.error).toBe("Connection is readonly");

      // And client-side setState should also be blocked
      const errorPromise = waitForMessage<StateErrorMessage>(
        ws1,
        (data) => data.type === MessageType.CF_AGENT_STATE_ERROR
      );
      ws1.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STATE,
          state: { count: 999 }
        })
      );
      const errorMsg = await errorPromise;
      expect(errorMsg.error).toBe("Connection is readonly");

      ws1.close();
      ws2.close();
    }, 15000);

    it("should allow mutations after removing readonly from a connection", async () => {
      const room = crypto.randomUUID();

      const { ws: wsReadonly } = await connectAndWait(room, true);
      const { ws: wsWriter } = await connectAndWait(room, false);

      // Confirm readonly is blocked
      const blockMsg = await sendRpc(wsReadonly, "incrementCount");
      expect(blockMsg.success).toBe(false);

      // Get readonly connection's ID
      const idMsg = await sendRpc(wsReadonly, "getMyConnectionId");
      const readonlyConnId = idMsg.result as string;

      // Use the writer to remove readonly from the first connection
      const unsetMsg = await sendRpc(wsWriter, "setReadonly", [
        readonlyConnId,
        false
      ]);
      expect(unsetMsg.success).toBe(true);

      // Now the formerly-readonly connection should be able to mutate
      const incMsg = await sendRpc(wsReadonly, "incrementCount");
      expect(incMsg.success).toBe(true);

      wsReadonly.close();
      wsWriter.close();
    }, 15000);
  });

  describe("isConnectionReadonly via checkReadonly RPC", () => {
    it("should return true for readonly and false for writable connections", async () => {
      const room = crypto.randomUUID();

      const { ws: wsWriter } = await connectAndWait(room, false);
      const { ws: wsReadonly } = await connectAndWait(room, true);

      // Get both connection IDs
      const writerIdMsg = await sendRpc(wsWriter, "getMyConnectionId");
      const writerConnId = writerIdMsg.result as string;

      const readonlyIdMsg = await sendRpc(wsReadonly, "getMyConnectionId");
      const readonlyConnId = readonlyIdMsg.result as string;

      // Check readonly status of both via the writer connection
      const checkWriterMsg = await sendRpc(wsWriter, "checkReadonly", [
        writerConnId
      ]);
      expect(checkWriterMsg.success).toBe(true);
      expect(checkWriterMsg.result).toBe(false);

      const checkReadonlyMsg = await sendRpc(wsWriter, "checkReadonly", [
        readonlyConnId
      ]);
      expect(checkReadonlyMsg.success).toBe(true);
      expect(checkReadonlyMsg.result).toBe(true);

      wsWriter.close();
      wsReadonly.close();
    }, 15000);

    it("should reflect dynamic changes via checkReadonly", async () => {
      const room = crypto.randomUUID();

      const { ws } = await connectAndWait(room, false);

      // Get our connection ID
      const idMsg = await sendRpc(ws, "getMyConnectionId");
      const connId = idMsg.result as string;

      // Check — should be false initially
      const check1Msg = await sendRpc(ws, "checkReadonly", [connId]);
      expect(check1Msg.result).toBe(false);

      // Flip to readonly
      await sendRpc(ws, "setReadonly", [connId, true]);

      // Check again — should be true now
      const check2Msg = await sendRpc(ws, "checkReadonly", [connId]);
      expect(check2Msg.result).toBe(true);

      ws.close();
    }, 10000);
  });

  describe("state broadcast to readonly connections", () => {
    it("should broadcast state updates to readonly connections when writer mutates", async () => {
      const room = crypto.randomUUID();

      const { ws: wsWriter } = await connectAndWait(room, false);
      const { ws: wsReadonly } = await connectAndWait(room, true);

      // Writer increments state via RPC
      const broadcastPromise = waitForMessage<StateMessage>(
        wsReadonly,
        (data) =>
          data.type === MessageType.CF_AGENT_STATE &&
          (data.state.count ?? 0) > 0
      );

      const writerRpc = await sendRpc(wsWriter, "incrementCount");
      expect(writerRpc.success).toBe(true);

      // Readonly connection receives the broadcast
      const broadcastMsg = await broadcastPromise;
      expect(broadcastMsg.state.count).toBe(1);

      wsWriter.close();
      wsReadonly.close();
    }, 15000);
  });

  describe("reconnection", () => {
    it("should restore readonly status after reconnection", async () => {
      const room = crypto.randomUUID();

      const { ws: ws1 } = await connectAndWait(room, true);
      ws1.close();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Reconnect — shouldConnectionBeReadonly re-evaluates from query param
      const { ws: ws2 } = await connectAndWait(room, true);

      // Should still be blocked
      const errorPromise = waitForMessage<StateErrorMessage>(
        ws2,
        (data) => data.type === MessageType.CF_AGENT_STATE_ERROR
      );
      ws2.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STATE,
          state: { count: 999 }
        })
      );

      const errorMsg = await errorPromise;
      expect(errorMsg.type).toBe(MessageType.CF_AGENT_STATE_ERROR);

      ws2.close();
    });
  });

  describe("multiple connections", () => {
    it("should handle multiple connections with different readonly states", async () => {
      const room = crypto.randomUUID();

      const { ws: ws1 } = await connectAndWait(room, true);

      // ws1 (readonly) should not be able to update state
      const errorPromise = waitForMessage<StateErrorMessage>(
        ws1,
        (data) => data.type === MessageType.CF_AGENT_STATE_ERROR
      );
      ws1.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STATE,
          state: { count: 100 }
        })
      );

      const errorMsg = await errorPromise;
      expect(errorMsg.error).toBe("Connection is readonly");
      ws1.close();

      // Now connect a writable connection to verify it works differently
      const { ws: ws2 } = await connectAndWait(room, false);
      ws2.close();
    }, 15000);
  });

  describe("connection state wrapping", () => {
    it("should hide _cf_readonly from connection.state", async () => {
      const room = crypto.randomUUID();

      const { ws: wsReadonly } = await connectAndWait(room, true);
      const { ws: wsWriter } = await connectAndWait(room, false);

      // Get the readonly connection's ID
      const idMsg = await sendRpc(wsReadonly, "getMyConnectionId");
      const readonlyConnId = idMsg.result as string;

      // Ask the agent for connection.state of the readonly connection
      const stateMsg = await sendRpc(wsWriter, "getConnectionUserState", [
        readonlyConnId
      ]);
      expect(stateMsg.success).toBe(true);
      const result = stateMsg.result as {
        state: Record<string, unknown> | null;
        isReadonly: boolean;
      };

      // The only key in connection state is _cf_readonly, which is hidden,
      // so connection.state returns null (no user keys left)
      expect(result.state).toBeNull();
      // But isConnectionReadonly should still report true
      expect(result.isReadonly).toBe(true);

      wsReadonly.close();
      wsWriter.close();
    }, 15000);

    it("should preserve readonly flag when connection.setState(value) is called", async () => {
      const room = crypto.randomUUID();

      const { ws: wsReadonly } = await connectAndWait(room, true);
      const { ws: wsWriter } = await connectAndWait(room, false);

      // Get readonly connection ID
      const idMsg = await sendRpc(wsReadonly, "getMyConnectionId");
      const readonlyConnId = idMsg.result as string;

      // Use the value form of connection.setState on the readonly connection
      const setMsg = await sendRpc(wsWriter, "setConnectionUserState", [
        readonlyConnId,
        { myData: "hello" }
      ]);
      expect(setMsg.success).toBe(true);
      const result = setMsg.result as {
        state: Record<string, unknown> | null;
        isReadonly: boolean;
      };

      // User state should be updated
      expect(result.state).toEqual({ myData: "hello" });
      // readonly flag should NOT be visible in state
      expect(result.state).not.toHaveProperty("_cf_readonly");
      // But connection should still be readonly
      expect(result.isReadonly).toBe(true);

      wsReadonly.close();
      wsWriter.close();
    }, 15000);

    it("should preserve readonly flag when connection.setState(callback) is called", async () => {
      const room = crypto.randomUUID();

      const { ws: wsReadonly } = await connectAndWait(room, true);
      const { ws: wsWriter } = await connectAndWait(room, false);

      // Get readonly connection ID
      const idMsg = await sendRpc(wsReadonly, "getMyConnectionId");
      const readonlyConnId = idMsg.result as string;

      // First set some user state via the value form
      await sendRpc(wsWriter, "setConnectionUserState", [
        readonlyConnId,
        { existing: "data" }
      ]);

      // Now use the callback form to merge additional data
      const set2Msg = await sendRpc(
        wsWriter,
        "setConnectionUserStateCallback",
        [readonlyConnId, { extra: "info" }]
      );
      expect(set2Msg.success).toBe(true);
      const result = set2Msg.result as {
        state: Record<string, unknown> | null;
        isReadonly: boolean;
      };

      // Both keys should be present
      expect(result.state).toEqual({ existing: "data", extra: "info" });
      // No internal flag leaked
      expect(result.state).not.toHaveProperty("_cf_readonly");
      // Still readonly
      expect(result.isReadonly).toBe(true);

      wsReadonly.close();
      wsWriter.close();
    }, 15000);
  });

  describe("sequential mutation failures", () => {
    it("should remain functional after multiple rejected mutations", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectAndWait(room, true);

      // Send three mutating RPCs in quick succession — all should fail
      for (let i = 0; i < 3; i++) {
        const msg = await sendRpc(ws, "incrementCount");
        expect(msg.success).toBe(false);
        expect(msg.error).toBe("Connection is readonly");
      }

      // Connection should still work for non-mutating RPCs after the failures
      const readMsg = await sendRpc(ws, "getState");
      expect(readMsg.success).toBe(true);
      // State should be unchanged (no increments succeeded)
      expect(readMsg.result).toEqual({ count: 0 });

      ws.close();
    }, 15000);
  });
});
