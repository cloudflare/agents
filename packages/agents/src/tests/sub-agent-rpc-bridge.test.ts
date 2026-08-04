import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { RPCRequest, RPCResponse } from "../index";
import { MessageType } from "../types";

function uniqueName(): string {
  return `rpc-bridge-test-${crypto.randomUUID()}`;
}

async function connectWS(parent: string, child: string): Promise<WebSocket> {
  const path =
    `/agents/test-sub-agent-parent/${parent}` +
    `/sub/slow-reply-sub-agent/${child}`;
  const response = await exports.default.fetch(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  expect(response.status).toBe(101);

  const ws = response.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return ws;
}

function callRPC(
  ws: WebSocket,
  method: string,
  args: unknown[] = [],
  timeoutMs = 3000
): Promise<RPCResponse> {
  const id = `${method}-${crypto.randomUUID()}`;
  const request: RPCRequest = { type: MessageType.RPC, id, method, args };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error(`RPC reply for ${method} never arrived`));
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      let response: RPCResponse;
      try {
        response = JSON.parse(event.data as string) as RPCResponse;
      } catch {
        return;
      }
      if (response.type !== MessageType.RPC || response.id !== id) return;
      if (response.success && response.done === false) return;

      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(response);
    };

    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify(request));
  });
}

function callStreamingRPC(
  ws: WebSocket,
  method: string,
  args: unknown[] = [],
  timeoutMs = 3000
): Promise<{ chunks: unknown[]; terminal: RPCResponse }> {
  const id = `${method}-${crypto.randomUUID()}`;
  const request: RPCRequest = { type: MessageType.RPC, id, method, args };

  return new Promise((resolve, reject) => {
    const chunks: unknown[] = [];
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error(`Streaming RPC reply for ${method} never arrived`));
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      let response: RPCResponse;
      try {
        response = JSON.parse(event.data as string) as RPCResponse;
      } catch {
        return;
      }
      if (response.type !== MessageType.RPC || response.id !== id) return;
      if (response.success && response.done === false) {
        chunks.push(response.result);
        return;
      }

      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve({ chunks, terminal: response });
    };

    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify(request));
  });
}

function expectSuccessfulResult(
  response: RPCResponse,
  expected: unknown
): void {
  expect(response.success).toBe(true);
  if (response.success) expect(response.result).toEqual(expected);
}

describe("facet RPC replies under concurrent frames (issue #1991)", () => {
  it("delivers a lone awaiting callable reply", async () => {
    const ws = await connectWS(uniqueName(), uniqueName());
    try {
      const response = await callRPC(ws, "slowEcho", ["solo"]);
      expectSuccessfulResult(response, "slow:solo");
    } finally {
      ws.close();
    }
  });

  it("keeps each callable reply on its originating frame", async () => {
    const ws = await connectWS(uniqueName(), uniqueName());
    try {
      const slow = callRPC(ws, "slowEcho", ["burst"]);
      const fast = await callRPC(ws, "fastEcho", ["burst"]);

      expectSuccessfulResult(fast, "fast:burst");
      expectSuccessfulResult(await slow, "slow:burst");
    } finally {
      ws.close();
    }
  });

  it("keeps a parentAgent reply on its originating frame", async () => {
    const ws = await connectWS(uniqueName(), uniqueName());
    try {
      const parent = callRPC(ws, "parentEcho", ["burst"]);
      const fast = await callRPC(ws, "fastEcho", ["burst"]);

      expectSuccessfulResult(fast, "fast:burst");
      expectSuccessfulResult(await parent, "parent:burst");
    } finally {
      ws.close();
    }
  });

  it("delivers a streaming reply through its originating frame", async () => {
    const ws = await connectWS(uniqueName(), uniqueName());
    try {
      const stream = callStreamingRPC(ws, "slowStreamingEcho", ["burst"]);
      const fast = await callRPC(ws, "fastEcho", ["burst"]);

      expectSuccessfulResult(fast, "fast:burst");
      const { chunks, terminal } = await stream;
      expect(chunks).toEqual(["slow-stream:burst:chunk"]);
      expectSuccessfulResult(terminal, "slow-stream:burst:done");
    } finally {
      ws.close();
    }
  });
});
