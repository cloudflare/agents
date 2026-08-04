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
import { describe, expect, it, vi } from "vitest";
import type { RPCRequest, RPCResponse } from "../index";
import { subscribe, type ObservabilityEvent } from "../observability";
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

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Condition was not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

function sendRPCWithoutWaiting(
  ws: WebSocket,
  method: string,
  args: unknown[] = []
): void {
  const request: RPCRequest = {
    type: MessageType.RPC,
    id: `${method}-${Math.random().toString(36).slice(2)}`,
    method,
    args
  };
  ws.send(JSON.stringify(request));
}

function callStreamingRPC(
  ws: WebSocket,
  method: string,
  args: unknown[] = [],
  timeoutMs = 3000
): Promise<{ chunks: unknown[]; terminal: RPCResponse }> {
  const id = `${method}-${Math.random().toString(36).slice(2)}`;
  const request: RPCRequest = { type: MessageType.RPC, id, method, args };

  return new Promise((resolve, reject) => {
    const chunks: unknown[] = [];
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(
        new Error(
          `Streaming RPC reply for ${method} timed out (${timeoutMs}ms)`
        )
      );
    }, timeoutMs);

    const handler = (event: MessageEvent) => {
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
      ws.removeEventListener("message", handler);
      resolve({ chunks, terminal: response });
    };

    ws.addEventListener("message", handler);
    ws.send(JSON.stringify(request));
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
  const rootWsPath = (name: string) => `/agents/test-sub-agent-parent/${name}`;
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

  it("contains an asynchronous success-reply delivery failure", async () => {
    const ws = await connectWS(rootWsPath(uniqueName()));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      sendRPCWithoutWaiting(ws, "forceReplyDeliveryFailure", [false]);
      await waitForCondition(() =>
        consoleError.mock.calls.some(
          ([message]) => message === "[Agent] RPC response delivery failed:"
        )
      );

      const healthyResponse = await callRPC(ws, "healthyEcho", ["connection"]);
      expect(healthyResponse.success).toBe(true);
      if (healthyResponse.success) {
        expect(healthyResponse.result).toBe("healthy:connection");
      }

      const deliveryFailures = consoleError.mock.calls.filter(
        ([message]) => message === "[Agent] RPC response delivery failed:"
      );
      expect(deliveryFailures).toHaveLength(1);
      expect(
        consoleError.mock.calls.some(([message]) => message === "RPC error:")
      ).toBe(false);
    } finally {
      consoleError.mockRestore();
      ws.close();
    }
  });

  it("records the callable error before a failed error-reply delivery", async () => {
    const ws = await connectWS(rootWsPath(uniqueName()));
    const events: ObservabilityEvent[] = [];
    const unsubscribe = subscribe("rpc", (event) => events.push(event));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      sendRPCWithoutWaiting(ws, "forceReplyDeliveryFailure", [true]);
      await waitForCondition(
        () =>
          events.some(
            (event) =>
              event.type === "rpc:error" &&
              event.payload.method === "forceReplyDeliveryFailure"
          ) &&
          consoleError.mock.calls.some(
            ([message]) => message === "[Agent] RPC response delivery failed:"
          )
      );

      const healthyResponse = await callRPC(ws, "healthyEcho", ["after-error"]);
      expect(healthyResponse.success).toBe(true);
      if (healthyResponse.success) {
        expect(healthyResponse.result).toBe("healthy:after-error");
      }

      const rpcErrors = consoleError.mock.calls.filter(
        ([message]) => message === "RPC error:"
      );
      expect(rpcErrors).toHaveLength(1);
      expect(rpcErrors[0]?.[1]).toEqual(
        expect.objectContaining({ message: "Intentional callable failure" })
      );
      expect(
        events.filter(
          (event) =>
            event.type === "rpc:error" &&
            event.payload.method === "forceReplyDeliveryFailure"
        )
      ).toHaveLength(1);
    } finally {
      consoleError.mockRestore();
      unsubscribe();
      ws.close();
    }
  });

  it("observes rejected deliveries from publicly constructed streams", async () => {
    const ws = await connectWS(wsPath(uniqueName(), uniqueName()));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const response = await callRPC(ws, "createStreamWithRejectedDelivery");
      expect(response.success).toBe(true);
      if (response.success) expect(response.result).toBe("created");
      await waitForCondition(() =>
        consoleError.mock.calls.some(
          ([message]) => message === "[Agent] RPC response delivery failed:"
        )
      );

      expect(
        consoleError.mock.calls.filter(
          ([message]) => message === "[Agent] RPC response delivery failed:"
        )
      ).toHaveLength(1);
    } finally {
      consoleError.mockRestore();
      ws.close();
    }
  });

  it("waits for a streaming delivery appended during the flush", async () => {
    const ws = await connectWS(rootWsPath(uniqueName()));
    const order: string[] = [];
    const observer = (event: MessageEvent) => {
      if (event.data === "late-stream-handler-complete") {
        order.push("handler-complete");
        return;
      }
      try {
        const response = JSON.parse(event.data as string) as RPCResponse;
        if (
          response.type === MessageType.RPC &&
          response.success &&
          response.done === true &&
          response.result === "late"
        ) {
          order.push("terminal-delivery");
        }
      } catch {
        // Ignore protocol and application frames unrelated to this stream.
      }
    };
    ws.addEventListener("message", observer);

    try {
      const marker = waitForTextFrame(ws, "late-stream-handler-complete");
      const stream = callStreamingRPC(ws, "streamWithLateDelivery");
      const [{ terminal }] = await Promise.all([stream, marker]);

      expect(terminal.success).toBe(true);
      if (terminal.success) expect(terminal.result).toBe("late");
      expect(order).toEqual(["terminal-delivery", "handler-complete"]);
    } finally {
      ws.removeEventListener("message", observer);
      ws.close();
    }
  });

  it("reports a non-serializable callable result as an RPC error", async () => {
    const ws = await connectWS(rootWsPath(uniqueName()));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const response = await callRPC(ws, "nonSerializableResult");
      expect(response.success).toBe(false);
      if (!response.success) expect(response.error).toContain("BigInt");
    } finally {
      consoleError.mockRestore();
      ws.close();
    }
  });

  it("reports a non-serializable streaming chunk as an RPC error", async () => {
    const ws = await connectWS(wsPath(uniqueName(), uniqueName()));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const { terminal } = await callStreamingRPC(
        ws,
        "nonSerializableStreamingResponse"
      );
      expect(terminal.success).toBe(false);
      if (!terminal.success) expect(terminal.error).toContain("BigInt");
    } finally {
      consoleError.mockRestore();
      ws.close();
    }
  });

  it("delivers every chunk from a burst stream while another RPC is in flight", async () => {
    const ws = await connectWS(wsPath(uniqueName(), uniqueName()));
    try {
      const stream = callStreamingRPC(ws, "burstStreamingEcho", [250]);
      const concurrent = await callRPC(ws, "fastEcho", ["alongside-burst"]);
      expect(concurrent.success).toBe(true);

      const { chunks, terminal } = await stream;
      expect(chunks).toEqual(Array.from({ length: 250 }, (_, index) => index));
      expect(terminal.success).toBe(true);
      if (terminal.success) expect(terminal.result).toBe(250);
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
