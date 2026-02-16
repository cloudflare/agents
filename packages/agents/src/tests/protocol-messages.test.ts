import { createExecutionContext, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, { type Env } from "./worker";
import { MessageType } from "../types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// ── Message types ─────────────────────────────────────────────────────

interface IdentityMessage {
  type: MessageType.CF_AGENT_IDENTITY;
  name: string;
  agent: string;
}

interface StateMessage {
  type: MessageType.CF_AGENT_STATE;
  state: { count?: number };
}

interface McpMessage {
  type: MessageType.CF_AGENT_MCP_SERVERS;
  mcp: unknown;
}

interface RpcMessage {
  type: MessageType.RPC;
  id: string;
  success?: boolean;
  result?: unknown;
  error?: string;
}

type TestMessage = IdentityMessage | StateMessage | McpMessage | RpcMessage;

function isTestMessage(data: unknown): data is TestMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    typeof (data as TestMessage).type === "string"
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

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

/** Collect all messages received within a time window. */
function collectMessages(ws: WebSocket, durationMs = 500): Promise<unknown[]> {
  return new Promise((resolve) => {
    const messages: unknown[] = [];
    const handler = (e: MessageEvent) => {
      try {
        messages.push(JSON.parse(e.data as string));
      } catch {
        messages.push(e.data);
      }
    };
    ws.addEventListener("message", handler);
    setTimeout(() => {
      ws.removeEventListener("message", handler);
      resolve(messages);
    }, durationMs);
  });
}

const BASE = "/agents/test-protocol-messages-agent";

/** Connect with protocol enabled (default) and wait for state message. */
async function connectProtocol(room: string) {
  const { ws, ctx } = await connectWS(`${BASE}/${room}`);
  await waitForMessage<StateMessage>(
    ws,
    (d) => d.type === MessageType.CF_AGENT_STATE
  );
  return { ws, ctx };
}

/** Connect with protocol disabled. */
async function connectNoProtocol(room: string) {
  const { ws, ctx } = await connectWS(`${BASE}/${room}?protocol=false`);
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

/** Extract protocol message types from an array of raw messages. */
function protocolTypes(messages: unknown[]): string[] {
  return messages
    .filter(
      (m): m is { type: string } =>
        typeof m === "object" && m !== null && "type" in m
    )
    .map((m) => m.type)
    .filter(
      (t) =>
        t === MessageType.CF_AGENT_IDENTITY ||
        t === MessageType.CF_AGENT_STATE ||
        t === MessageType.CF_AGENT_MCP_SERVERS
    );
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("Protocol Messages", () => {
  describe("shouldSendProtocolMessages hook", () => {
    it("should send identity, state, and mcp_servers to protocol-enabled connections", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS(`${BASE}/${room}`);

      const messages = await collectMessages(ws, 1000);
      ws.close();

      const types = protocolTypes(messages);
      expect(types).toContain(MessageType.CF_AGENT_IDENTITY);
      expect(types).toContain(MessageType.CF_AGENT_STATE);
      expect(types).toContain(MessageType.CF_AGENT_MCP_SERVERS);
    }, 10000);

    it("should NOT send any protocol messages to no-protocol connections", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectNoProtocol(room);

      const messages = await collectMessages(ws, 1000);
      ws.close();

      const types = protocolTypes(messages);
      expect(types).toHaveLength(0);
    }, 10000);
  });

  describe("isConnectionProtocolEnabled predicate", () => {
    it("should return true for protocol-enabled connections", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectProtocol(room);

      const idMsg = await sendRpc(ws, "getMyConnectionId");
      expect(idMsg.success).toBe(true);
      const connId = idMsg.result as string;

      const checkMsg = await sendRpc(ws, "checkProtocolEnabled", [connId]);
      expect(checkMsg.success).toBe(true);
      expect(checkMsg.result).toBe(true);

      ws.close();
    }, 10000);

    it("should return false for no-protocol connections", async () => {
      const room = crypto.randomUUID();
      const { ws: wsNoProto } = await connectNoProtocol(room);
      const { ws: wsProto } = await connectProtocol(room);

      const idMsg = await sendRpc(wsNoProto, "getMyConnectionId");
      expect(idMsg.success).toBe(true);
      const noProtoConnId = idMsg.result as string;

      const checkMsg = await sendRpc(wsProto, "checkProtocolEnabled", [
        noProtoConnId
      ]);
      expect(checkMsg.success).toBe(true);
      expect(checkMsg.result).toBe(false);

      wsNoProto.close();
      wsProto.close();
    }, 10000);
  });

  describe("RPC still works on no-protocol connections", () => {
    it("should allow RPC calls from no-protocol connections", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectNoProtocol(room);

      const rpcMsg = await sendRpc(ws, "getState");
      expect(rpcMsg.success).toBe(true);
      expect(rpcMsg.result).toEqual({ count: 0 });

      ws.close();
    }, 10000);

    it("should allow mutating RPC calls from no-protocol connections", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectNoProtocol(room);

      const rpcMsg = await sendRpc(ws, "incrementCount");
      expect(rpcMsg.success).toBe(true);
      expect(rpcMsg.result).toBe(1);

      ws.close();
    }, 10000);
  });

  describe("state broadcast filtering", () => {
    it("should broadcast state to protocol-enabled connections but not no-protocol connections", async () => {
      const room = crypto.randomUUID();
      const { ws: wsProto } = await connectProtocol(room);
      const { ws: wsNoProto } = await connectNoProtocol(room);

      const broadcastPromise = waitForMessage<StateMessage>(
        wsProto,
        (d) => d.type === MessageType.CF_AGENT_STATE && (d.state.count ?? 0) > 0
      );

      const noProtoMessages = collectMessages(wsNoProto, 2000);

      const rpcMsg = await sendRpc(wsNoProto, "incrementCount");
      expect(rpcMsg.success).toBe(true);

      const broadcastMsg = await broadcastPromise;
      expect(broadcastMsg.state.count).toBe(1);

      const messages = await noProtoMessages;
      const stateMessages = messages.filter(
        (m): m is StateMessage =>
          typeof m === "object" &&
          m !== null &&
          "type" in m &&
          (m as StateMessage).type === MessageType.CF_AGENT_STATE
      );
      expect(stateMessages).toHaveLength(0);

      wsProto.close();
      wsNoProto.close();
    }, 15000);

    it("should exclude no-protocol connections from state broadcast when another client mutates", async () => {
      const room = crypto.randomUUID();
      const { ws: wsMutator } = await connectProtocol(room);
      const { ws: wsObserver } = await connectProtocol(room);
      const { ws: wsNoProto } = await connectNoProtocol(room);

      const observerPromise = waitForMessage<StateMessage>(
        wsObserver,
        (d) => d.type === MessageType.CF_AGENT_STATE && (d.state.count ?? 0) > 0
      );

      const noProtoMessages = collectMessages(wsNoProto, 2000);

      const rpcMsg = await sendRpc(wsMutator, "incrementCount");
      expect(rpcMsg.success).toBe(true);

      const broadcastMsg = await observerPromise;
      expect(broadcastMsg.state.count).toBe(1);

      const messages = await noProtoMessages;
      const stateMessages = messages.filter(
        (m): m is StateMessage =>
          typeof m === "object" &&
          m !== null &&
          "type" in m &&
          (m as StateMessage).type === MessageType.CF_AGENT_STATE
      );
      expect(stateMessages).toHaveLength(0);

      wsMutator.close();
      wsObserver.close();
      wsNoProto.close();
    }, 15000);
  });

  describe("mixed connections in the same room", () => {
    it("should handle protocol and no-protocol connections coexisting", async () => {
      const room = crypto.randomUUID();

      const { ws: wsProto } = await connectProtocol(room);
      const { ws: wsNoProto } = await connectNoProtocol(room);

      // Both can make RPC calls
      const protoState = await sendRpc(wsProto, "getState");
      expect(protoState.success).toBe(true);
      expect(protoState.result).toEqual({ count: 0 });

      const noProtoState = await sendRpc(wsNoProto, "getState");
      expect(noProtoState.success).toBe(true);
      expect(noProtoState.result).toEqual({ count: 0 });

      // Both can mutate
      const inc1 = await sendRpc(wsProto, "incrementCount");
      expect(inc1.success).toBe(true);
      expect(inc1.result).toBe(1);

      const inc2 = await sendRpc(wsNoProto, "incrementCount");
      expect(inc2.success).toBe(true);
      expect(inc2.result).toBe(2);

      wsProto.close();
      wsNoProto.close();
    }, 15000);
  });

  describe("reconnection", () => {
    it("should re-evaluate shouldSendProtocolMessages on reconnect", async () => {
      const room = crypto.randomUUID();

      // First connection with protocol disabled
      const { ws: ws1 } = await connectNoProtocol(room);

      // Set some state so it would be sent on reconnect
      await sendRpc(ws1, "incrementCount");
      ws1.close();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Reconnect with protocol enabled — should now receive protocol messages
      const { ws: ws2 } = await connectWS(`${BASE}/${room}`);

      const messages = await collectMessages(ws2, 1000);
      ws2.close();

      const types = protocolTypes(messages);
      expect(types).toContain(MessageType.CF_AGENT_IDENTITY);
      expect(types).toContain(MessageType.CF_AGENT_STATE);
      expect(types).toContain(MessageType.CF_AGENT_MCP_SERVERS);
    }, 15000);

    it("should suppress protocol messages on reconnect when hook returns false", async () => {
      const room = crypto.randomUUID();

      // First connect with protocol enabled, set some state
      const { ws: ws1 } = await connectProtocol(room);
      await sendRpc(ws1, "incrementCount");
      ws1.close();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Reconnect with protocol disabled
      const { ws: ws2 } = await connectNoProtocol(room);

      const messages = await collectMessages(ws2, 1000);
      ws2.close();

      const types = protocolTypes(messages);
      expect(types).toHaveLength(0);
    }, 15000);
  });

  describe("connection state wrapping", () => {
    it("should hide _cf_no_protocol from connection.state", async () => {
      const room = crypto.randomUUID();
      const { ws: wsNoProto } = await connectNoProtocol(room);
      const { ws: wsProto } = await connectProtocol(room);

      // Get no-protocol connection's ID
      const idMsg = await sendRpc(wsNoProto, "getMyConnectionId");
      const noProtoConnId = idMsg.result as string;

      // Ask the agent for connection.state of the no-protocol connection
      const stateMsg = await sendRpc(wsProto, "getConnectionUserState", [
        noProtoConnId
      ]);
      expect(stateMsg.success).toBe(true);
      const result = stateMsg.result as {
        state: Record<string, unknown> | null;
        isProtocolEnabled: boolean;
        isReadonly: boolean;
      };

      // The only key in connection state is _cf_no_protocol, which is hidden,
      // so connection.state returns null (no user keys left)
      expect(result.state).toBeNull();
      // _cf_no_protocol should not appear
      if (result.state !== null) {
        expect(result.state).not.toHaveProperty("_cf_no_protocol");
      }
      // But isConnectionProtocolEnabled should still report false
      expect(result.isProtocolEnabled).toBe(false);

      wsNoProto.close();
      wsProto.close();
    }, 10000);

    it("should preserve no-protocol flag when connection.setState(value) is called", async () => {
      const room = crypto.randomUUID();
      const { ws: wsNoProto } = await connectNoProtocol(room);
      const { ws: wsProto } = await connectProtocol(room);

      // Get no-protocol connection's ID
      const idMsg = await sendRpc(wsNoProto, "getMyConnectionId");
      const noProtoConnId = idMsg.result as string;

      // Use the value form of connection.setState on the no-protocol connection
      const setMsg = await sendRpc(wsProto, "setConnectionUserState", [
        noProtoConnId,
        { myData: "hello" }
      ]);
      expect(setMsg.success).toBe(true);
      const result = setMsg.result as {
        state: Record<string, unknown> | null;
        isProtocolEnabled: boolean;
      };

      // User state should be updated
      expect(result.state).toEqual({ myData: "hello" });
      // _cf_no_protocol should NOT be visible in state
      expect(result.state).not.toHaveProperty("_cf_no_protocol");
      // But connection should still be no-protocol
      expect(result.isProtocolEnabled).toBe(false);

      wsNoProto.close();
      wsProto.close();
    }, 10000);

    it("should preserve no-protocol flag when connection.setState(callback) is called", async () => {
      const room = crypto.randomUUID();
      const { ws: wsNoProto } = await connectNoProtocol(room);
      const { ws: wsProto } = await connectProtocol(room);

      // Get no-protocol connection's ID
      const idMsg = await sendRpc(wsNoProto, "getMyConnectionId");
      const noProtoConnId = idMsg.result as string;

      // First set some user state via the value form
      await sendRpc(wsProto, "setConnectionUserState", [
        noProtoConnId,
        { existing: "data" }
      ]);

      // Now use the callback form to merge additional data
      const set2Msg = await sendRpc(wsProto, "setConnectionUserStateCallback", [
        noProtoConnId,
        { extra: "info" }
      ]);
      expect(set2Msg.success).toBe(true);
      const result = set2Msg.result as {
        state: Record<string, unknown> | null;
        isProtocolEnabled: boolean;
      };

      // Both keys should be present
      expect(result.state).toEqual({ existing: "data", extra: "info" });
      // No internal flag leaked
      expect(result.state).not.toHaveProperty("_cf_no_protocol");
      // Still no-protocol
      expect(result.isProtocolEnabled).toBe(false);

      wsNoProto.close();
      wsProto.close();
    }, 10000);
  });

  describe("readonly + no-protocol combined", () => {
    it("should support both flags on the same connection", async () => {
      const room = crypto.randomUUID();

      // Connect with both readonly and no-protocol
      const { ws: wsBoth } = await connectWS(
        `${BASE}/${room}?protocol=false&readonly=true`
      );
      // Connect a normal connection to inspect from
      const { ws: wsNormal } = await connectProtocol(room);

      // Get the dual-flag connection's ID
      const idMsg = await sendRpc(wsBoth, "getMyConnectionId");
      expect(idMsg.success).toBe(true);
      const bothConnId = idMsg.result as string;

      // Verify both flags are set
      const checkProto = await sendRpc(wsNormal, "checkProtocolEnabled", [
        bothConnId
      ]);
      expect(checkProto.success).toBe(true);
      expect(checkProto.result).toBe(false);

      const checkReadonly = await sendRpc(wsNormal, "checkReadonly", [
        bothConnId
      ]);
      expect(checkReadonly.success).toBe(true);
      expect(checkReadonly.result).toBe(true);

      // connection.state should hide BOTH internal flags
      const stateMsg = await sendRpc(wsNormal, "getConnectionUserState", [
        bothConnId
      ]);
      expect(stateMsg.success).toBe(true);
      const result = stateMsg.result as {
        state: Record<string, unknown> | null;
        isProtocolEnabled: boolean;
        isReadonly: boolean;
      };
      expect(result.state).toBeNull();
      expect(result.isProtocolEnabled).toBe(false);
      expect(result.isReadonly).toBe(true);

      // Mutating RPC should be blocked (readonly)
      const incMsg = await sendRpc(wsBoth, "incrementCount");
      expect(incMsg.success).toBe(false);
      expect(incMsg.error).toBe("Connection is readonly");

      // Read-only RPC should still work
      const readMsg = await sendRpc(wsBoth, "getState");
      expect(readMsg.success).toBe(true);
      expect(readMsg.result).toEqual({ count: 0 });

      wsBoth.close();
      wsNormal.close();
    }, 15000);

    it("should preserve both flags when connection.setState is called", async () => {
      const room = crypto.randomUUID();

      const { ws: wsBoth } = await connectWS(
        `${BASE}/${room}?protocol=false&readonly=true`
      );
      const { ws: wsNormal } = await connectProtocol(room);

      // Get dual-flag connection's ID
      const idMsg = await sendRpc(wsBoth, "getMyConnectionId");
      const bothConnId = idMsg.result as string;

      // Set user state on the dual-flag connection via a normal connection
      const setMsg = await sendRpc(wsNormal, "setConnectionUserState", [
        bothConnId,
        { device: "sensor-1" }
      ]);
      expect(setMsg.success).toBe(true);
      const result = setMsg.result as {
        state: Record<string, unknown> | null;
        isProtocolEnabled: boolean;
        isReadonly: boolean;
      };

      // User state should be updated
      expect(result.state).toEqual({ device: "sensor-1" });
      // No internal flags leaked
      expect(result.state).not.toHaveProperty("_cf_no_protocol");
      expect(result.state).not.toHaveProperty("_cf_readonly");
      // Both flags still active
      expect(result.isProtocolEnabled).toBe(false);
      expect(result.isReadonly).toBe(true);

      wsBoth.close();
      wsNormal.close();
    }, 10000);
  });
});
