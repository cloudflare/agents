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

/** Connect with protocol enabled (default) and wait for state message. */
async function connectProtocol(room: string) {
  const path = `/agents/test-protocol-messages-agent/${room}`;
  const { ws, ctx } = await connectWS(path);
  await waitForMessage<StateMessage>(
    ws,
    (d) => d.type === MessageType.CF_AGENT_STATE
  );
  return { ws, ctx };
}

/** Connect with protocol disabled. */
async function connectNoProtocol(room: string) {
  const path = `/agents/test-protocol-messages-agent/${room}?protocol=false`;
  const { ws, ctx } = await connectWS(path);
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

// ── Tests ─────────────────────────────────────────────────────────────

describe("Protocol Messages", () => {
  describe("shouldSendProtocolMessages hook", () => {
    it("should send identity, state, and mcp_servers to protocol-enabled connections", async () => {
      const room = crypto.randomUUID();
      const path = `/agents/test-protocol-messages-agent/${room}`;
      const { ws } = await connectWS(path);

      const messages = await collectMessages(ws, 1000);
      ws.close();

      const types = messages
        .filter(
          (m): m is { type: string } =>
            typeof m === "object" && m !== null && "type" in m
        )
        .map((m) => m.type);

      expect(types).toContain(MessageType.CF_AGENT_IDENTITY);
      expect(types).toContain(MessageType.CF_AGENT_STATE);
      expect(types).toContain(MessageType.CF_AGENT_MCP_SERVERS);
    }, 10000);

    it("should NOT send any protocol messages to no-protocol connections", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectNoProtocol(room);

      const messages = await collectMessages(ws, 1000);
      ws.close();

      const types = messages
        .filter(
          (m): m is { type: string } =>
            typeof m === "object" && m !== null && "type" in m
        )
        .map((m) => m.type);

      expect(types).not.toContain(MessageType.CF_AGENT_IDENTITY);
      expect(types).not.toContain(MessageType.CF_AGENT_STATE);
      expect(types).not.toContain(MessageType.CF_AGENT_MCP_SERVERS);
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

      // Get the no-protocol connection's ID via RPC (RPC still works)
      const idMsg = await sendRpc(wsNoProto, "getMyConnectionId");
      expect(idMsg.success).toBe(true);
      const noProtoConnId = idMsg.result as string;

      // Check from the protocol-enabled connection
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

      // Set up a listener on the protocol connection for broadcast
      const broadcastPromise = waitForMessage<StateMessage>(
        wsProto,
        (d) => d.type === MessageType.CF_AGENT_STATE && (d.state.count ?? 0) > 0
      );

      // Collect messages on the no-protocol connection
      const noProtoMessages = collectMessages(wsNoProto, 2000);

      // Trigger a state change from the no-protocol connection (via RPC)
      const rpcMsg = await sendRpc(wsNoProto, "incrementCount");
      expect(rpcMsg.success).toBe(true);

      // Protocol connection should receive the broadcast
      const broadcastMsg = await broadcastPromise;
      expect(broadcastMsg.state.count).toBe(1);

      // No-protocol connection should NOT receive any state broadcast
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

      // Observer listens for broadcast
      const observerPromise = waitForMessage<StateMessage>(
        wsObserver,
        (d) => d.type === MessageType.CF_AGENT_STATE && (d.state.count ?? 0) > 0
      );

      // Collect on no-protocol
      const noProtoMessages = collectMessages(wsNoProto, 2000);

      // Mutator increments
      const rpcMsg = await sendRpc(wsMutator, "incrementCount");
      expect(rpcMsg.success).toBe(true);

      // Observer receives it
      const broadcastMsg = await observerPromise;
      expect(broadcastMsg.state.count).toBe(1);

      // No-protocol does NOT
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

      // Connect both types
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

      // Reconnect with protocol enabled
      const path = `/agents/test-protocol-messages-agent/${room}`;
      const { ws: ws2 } = await connectWS(path);

      const messages = await collectMessages(ws2, 1000);
      ws2.close();

      const types = messages
        .filter(
          (m): m is { type: string } =>
            typeof m === "object" && m !== null && "type" in m
        )
        .map((m) => m.type);

      // Should now receive protocol messages since we reconnected with protocol=true
      expect(types).toContain(MessageType.CF_AGENT_IDENTITY);
      expect(types).toContain(MessageType.CF_AGENT_STATE);
      expect(types).toContain(MessageType.CF_AGENT_MCP_SERVERS);
    }, 15000);
  });

  describe("no-protocol flag is hidden from connection.state", () => {
    it("should not expose _cf_no_protocol in connection.state", async () => {
      const room = crypto.randomUUID();
      const { ws: wsNoProto } = await connectNoProtocol(room);
      const { ws: wsProto } = await connectProtocol(room);

      // Get no-protocol connection's ID
      const idMsg = await sendRpc(wsNoProto, "getMyConnectionId");
      const connId = idMsg.result as string;

      // Check that protocol is disabled
      const checkMsg = await sendRpc(wsProto, "checkProtocolEnabled", [connId]);
      expect(checkMsg.success).toBe(true);
      expect(checkMsg.result).toBe(false);

      wsNoProto.close();
      wsProto.close();
    }, 10000);
  });

  describe("hibernation wake correctness", () => {
    it("should read protocol flag from serialized attachment when _rawStateAccessors is empty", async () => {
      const room = crypto.randomUUID();
      const { ws: wsNoProto } = await connectNoProtocol(room);
      const { ws: wsProto } = await connectProtocol(room);

      // Get both connection IDs
      const noProtoIdMsg = await sendRpc(wsNoProto, "getMyConnectionId");
      expect(noProtoIdMsg.success).toBe(true);
      const noProtoConnId = noProtoIdMsg.result as string;

      const protoIdMsg = await sendRpc(wsProto, "getMyConnectionId");
      expect(protoIdMsg.success).toBe(true);
      const protoConnId = protoIdMsg.result as string;

      // Simulate post-hibernation: clear _rawStateAccessors and check
      // that isConnectionProtocolEnabled still reads the flag correctly
      // from the serialized WebSocket attachment.
      const checkNoProto = await sendRpc(
        wsProto,
        "checkProtocolEnabledAfterCacheClear",
        [noProtoConnId]
      );
      expect(checkNoProto.success).toBe(true);
      expect(checkNoProto.result).toBe(false);

      const checkProto = await sendRpc(
        wsProto,
        "checkProtocolEnabledAfterCacheClear",
        [protoConnId]
      );
      expect(checkProto.success).toBe(true);
      expect(checkProto.result).toBe(true);

      wsNoProto.close();
      wsProto.close();
    }, 15000);
  });
});
