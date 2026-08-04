/**
 * Issue #1991 — RPC reply silently dropped for a facet @callable that
 * awaits before returning, under concurrent useAgent().call() frames.
 *
 * A facet's client connection is VIRTUAL: every incoming WebSocket frame
 * is forwarded from the root DO via `_cf_handleSubAgentWebSocketMessage`,
 * carrying a fresh per-frame `SubAgentConnectionBridge` (an RpcTarget).
 * `_cf_createSubAgentBridgeConnection` stores that bridge on the SHARED
 * virtual connection (`stored.bridge = bridge`), and the connection's
 * `send()` resolves `getStored().bridge` AT SEND TIME.
 *
 * So when frame A's handler suspends (awaits) and frame B arrives on the
 * same socket, B overwrites the stored bridge. B's RPC completes, its
 * bridge stub is disposed — and when A's handler resumes, its reply goes
 * to the disposed bridge and never reaches the client.
 *
 * The discriminator: a lone awaiting call works (its own bridge is still
 * live); only awaiting + a concurrent frame loses the reply.
 */
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { RPCRequest, RPCResponse } from "../index";
import { MessageType } from "../types";

function uniqueName() {
  return `rpc-bridge-test-${Math.random().toString(36).slice(2)}`;
}

async function connectWS(path: string): Promise<WebSocket> {
  const res = await exports.default.fetch(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return ws;
}

/**
 * Send one RPC frame and resolve with the matching terminal response.
 * Matching is by request id, so interleaved protocol frames (identity,
 * state, mcp_servers) and other calls' responses are ignored.
 */
function waitForTextFrame(
  ws: WebSocket,
  expected: string,
  timeoutMs = 1000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error(`Text frame ${JSON.stringify(expected)} never arrived`));
    }, timeoutMs);

    const handler = (event: MessageEvent) => {
      if (event.data !== expected) return;
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
      resolve(event.data as string);
    };

    ws.addEventListener("message", handler);
  });
}

function callRPC(
  ws: WebSocket,
  method: string,
  args: unknown[] = [],
  timeoutMs = 3000
): Promise<RPCResponse> {
  const id = `${method}-${Math.random().toString(36).slice(2)}`;
  const request: RPCRequest = { type: MessageType.RPC, id, method, args };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(
        new Error(`RPC reply for ${method} never arrived (${timeoutMs}ms)`)
      );
    }, timeoutMs);

    const handler = (e: MessageEvent) => {
      let msg: RPCResponse;
      try {
        msg = JSON.parse(e.data as string) as RPCResponse;
      } catch {
        return; // non-JSON frame
      }
      if (msg.type !== MessageType.RPC || msg.id !== id) return;
      if (msg.success && msg.done === false) return; // streaming chunk
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
      resolve(msg);
    };

    ws.addEventListener("message", handler);
    ws.send(JSON.stringify(request));
  });
}

describe("facet @callable RPC replies under concurrent frames (issue #1991)", () => {
  const wsPath = (parent: string, child: string) =>
    `/agents/test-sub-agent-parent/${parent}/sub/slow-reply-sub-agent/${child}`;
  const nestedWsPath = (parent: string, middle: string, child: string) =>
    `/agents/test-sub-agent-parent/${parent}/sub/outer-sub-agent/${middle}/sub/slow-reply-sub-agent/${child}`;

  // Control: a lone awaiting @callable replies fine — its frame's RPC (and
  // bridge) stays live until the handler finishes. Passes before and after
  // the fix; proves the failure below is specifically about concurrency.
  it("delivers the reply of an awaiting @callable when it is the only in-flight call", async () => {
    const ws = await connectWS(wsPath(uniqueName(), uniqueName()));
    try {
      const res = await callRPC(ws, "slowEcho", ["solo"]);
      expect(res.success).toBe(true);
      if (res.success) expect(res.result).toBe("slow:solo");
    } finally {
      ws.close();
    }
  });

  // The bug: fire an awaiting call, then a synchronous call on the same
  // socket while the first is suspended. The sync call's frame overwrites
  // the shared bridge; by the time the awaiting handler resumes, that
  // bridge's RPC has completed and its stub is disposed — the reply is
  // dropped and this promise rejects on timeout.
  it("delivers the reply of an awaiting @callable when a concurrent frame lands on the same socket", async () => {
    const ws = await connectWS(wsPath(uniqueName(), uniqueName()));
    try {
      const slowPromise = callRPC(ws, "slowEcho", ["burst"]);
      const fastRes = await callRPC(ws, "fastEcho", ["burst"]);

      expect(fastRes.success).toBe(true);
      if (fastRes.success) expect(fastRes.result).toBe("fast:burst");

      const slowRes = await slowPromise;
      expect(slowRes.success).toBe(true);
      if (slowRes.success) expect(slowRes.result).toBe("slow:burst");
    } finally {
      ws.close();
    }
  });

  it("delivers a streaming @callable reply when a concurrent frame lands", async () => {
    const ws = await connectWS(wsPath(uniqueName(), uniqueName()));
    try {
      const slowPromise = callRPC(ws, "slowStreamingEcho", ["burst"]);
      const fastRes = await callRPC(ws, "fastEcho", ["burst"]);

      expect(fastRes.success).toBe(true);
      if (fastRes.success) expect(fastRes.result).toBe("fast:burst");

      const slowRes = await slowPromise;
      expect(slowRes.success).toBe(true);
      if (slowRes.success) expect(slowRes.result).toBe("slow-stream:burst");
    } finally {
      ws.close();
    }
  });

  it("delivers an out-of-band broadcast after concurrent frames finish out of order", async () => {
    const ws = await connectWS(wsPath(uniqueName(), uniqueName()));
    try {
      const first = callRPC(ws, "delayedEcho", ["first", 50]);
      const second = callRPC(ws, "delayedEcho", ["second", 150]);

      const [firstRes, secondRes] = await Promise.all([first, second]);
      expect(firstRes.success).toBe(true);
      expect(secondRes.success).toBe(true);

      const broadcast = waitForTextFrame(ws, "after-concurrent-frames");
      const scheduled = await callRPC(ws, "broadcastAfterDelay", [
        "after-concurrent-frames",
        25
      ]);
      expect(scheduled.success).toBe(true);
      if (scheduled.success) expect(scheduled.result).toBe("scheduled");

      await expect(broadcast).resolves.toBe("after-concurrent-frames");
    } finally {
      ws.close();
    }
  });

  it("honors the explicit connection passed to StreamingResponse", async () => {
    const ws = await connectWS(wsPath(uniqueName(), uniqueName()));
    try {
      const response = await callRPC(
        ws,
        "streamingResponseUsesExplicitConnection"
      );
      expect(response.success).toBe(true);
      if (response.success) expect(response.result).toBe(true);
    } finally {
      ws.close();
    }
  });

  // TODO: Unskip after https://github.com/cloudflare/agents/issues/2026 lands.
  it.skip("preserves the awaiting reply bridge through nested facets", async () => {
    const ws = await connectWS(
      nestedWsPath(uniqueName(), uniqueName(), uniqueName())
    );
    try {
      const slowPromise = callRPC(ws, "slowEcho", ["nested"]);
      const fastRes = await callRPC(ws, "fastEcho", ["nested"]);

      expect(fastRes.success).toBe(true);
      if (fastRes.success) expect(fastRes.result).toBe("fast:nested");

      const slowRes = await slowPromise;
      expect(slowRes.success).toBe(true);
      if (slowRes.success) expect(slowRes.result).toBe("slow:nested");
    } finally {
      ws.close();
    }
  });
});
