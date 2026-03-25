import { describe, it, expect } from "vitest";
import { exports } from "cloudflare:workers";
import type { RPCResponse } from "../..";
import { MessageType } from "../../types";

async function connectWS(path: string) {
  const res = await exports.default.fetch(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws };
}

function collectMessages(
  ws: WebSocket,
  count: number,
  timeout = 5000
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    const timer = setTimeout(() => {
      reject(
        new Error(`Timeout: received ${messages.length}/${count} messages`)
      );
    }, timeout);
    const handler = (e: MessageEvent) => {
      messages.push(JSON.parse(e.data as string));
      if (messages.length === count) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(messages);
      }
    };
    ws.addEventListener("message", handler);
  });
}

async function callRPC(
  ws: WebSocket,
  method: string,
  args: unknown[] = [],
  timeout = 5000
): Promise<RPCResponse> {
  const id = Math.random().toString(36).slice(2);
  ws.send(JSON.stringify({ type: MessageType.RPC, id, method, args } as const));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`RPC timeout for ${method}`)),
      timeout
    );
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as RPCResponse;
      if (msg.type === MessageType.RPC && msg.id === id) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(msg);
      }
    };
    ws.addEventListener("message", handler);
  });
}

describe("connection.uri in callable context", () => {
  it("should expose connection.uri via getCurrentAgent() inside a callable", async () => {
    const room = `uri-test-${crypto.randomUUID()}`;
    const { ws } = await connectWS(`/agents/test-connection-uri-agent/${room}`);

    // Agent with no initialState sends 2 initial messages (identity + mcp_servers)
    const initMsgs = await collectMessages(ws, 2);
    const types = initMsgs.map((m) => (m as { type: string }).type);
    expect(types).toContain(MessageType.CF_AGENT_IDENTITY);
    expect(types).toContain(MessageType.CF_AGENT_MCP_SERVERS);

    const response = await callRPC(ws, "getConnectionContext");
    expect(response.success).toBe(true);

    const result = (response as Extract<RPCResponse, { success: true }>)
      .result as {
      hasConnection: boolean;
      connectionUri: string | null;
      hasRequest: boolean;
      requestUrl: string | null;
    };

    expect(result.hasConnection).toBe(true);
    expect(result.connectionUri).toBe(
      `http://example.com/agents/test-connection-uri-agent/${room}`
    );
    expect(result.hasRequest).toBe(false);
    expect(result.requestUrl).toBeNull();

    ws.close();
  });

  it("should derive the correct host from connection.uri", async () => {
    const room = `host-derive-${crypto.randomUUID()}`;
    const { ws } = await connectWS(
      `/agents/test-connection-uri-agent/${room}?token=abc`
    );

    await collectMessages(ws, 2);

    const response = await callRPC(ws, "getConnectionContext");
    expect(response.success).toBe(true);

    const result = (response as Extract<RPCResponse, { success: true }>)
      .result as {
      connectionUri: string | null;
    };

    const uri = new URL(result.connectionUri!);
    expect(uri.protocol).toBe("http:");
    expect(uri.host).toBe("example.com");
    expect(uri.searchParams.get("token")).toBe("abc");

    ws.close();
  });
});
