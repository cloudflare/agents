import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { getAgentByName, type RPCRequest, type RPCResponse } from "../index";
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

function waitForTextMessage(
  ws: WebSocket,
  expected: string,
  timeoutMs = 1000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error(`Message ${JSON.stringify(expected)} never arrived`));
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      if (event.data !== expected) return;

      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(event.data as string);
    };

    ws.addEventListener("message", onMessage);
  });
}

function waitForTextMessages(
  ws: WebSocket,
  expected: ReadonlySet<string>,
  timeoutMs = 1000
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const received: string[] = [];
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("Expected text messages never arrived"));
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string" || !expected.has(event.data)) return;
      received.push(event.data);
      if (received.length !== expected.size) return;

      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(received);
    };

    ws.addEventListener("message", onMessage);
  });
}

function waitForClose(
  ws: WebSocket,
  timeoutMs = 1000
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("close", onClose);
      reject(new Error("WebSocket did not close"));
    }, timeoutMs);

    const onClose = (event: CloseEvent) => {
      clearTimeout(timer);
      ws.removeEventListener("close", onClose);
      resolve({ code: event.code, reason: event.reason });
    };

    ws.addEventListener("close", onClose);
  });
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

describe("facet connection operations after frame completion (issue #2055)", () => {
  it("delivers a connection message", async () => {
    const ws = await connectWS(uniqueName(), uniqueName());
    try {
      const message = "delayed-connection-message";
      const delivered = waitForTextMessage(ws, message);

      const response = await callRPC(ws, "sendConnectionMessageAfterDelay", [
        message
      ]);
      expectSuccessfulResult(response, "scheduled");
      await expect(delivered).resolves.toBe(message);
    } finally {
      ws.close();
    }
  });

  it("keeps a live-frame send behind an older queued send", async () => {
    const parentName = uniqueName();
    const ws = await connectWS(parentName, uniqueName());
    try {
      const parent = await getAgentByName(env.TestSubAgentParent, parentName);
      await parent.delayNextRootResolution(300);
      const first = `queued-first-${crypto.randomUUID()}`;
      const second = `live-second-${crypto.randomUUID()}`;
      const delivered = waitForTextMessages(ws, new Set([first, second]), 2000);

      const scheduled = await callRPC(ws, "sendConnectionMessageAfterDelay", [
        first
      ]);
      expectSuccessfulResult(scheduled, "scheduled");
      await new Promise((resolve) => setTimeout(resolve, 75));
      const sent = await callRPC(ws, "sendConnectionMessageNow", [second]);
      expectSuccessfulResult(sent, "sent");

      await expect(delivered).resolves.toEqual([first, second]);
    } finally {
      ws.close();
    }
  });

  it("keeps a live-frame state update behind an older queued update", async () => {
    const parentName = uniqueName();
    const ws = await connectWS(parentName, uniqueName());
    try {
      const parent = await getAgentByName(env.TestSubAgentParent, parentName);
      await parent.delayNextRootResolution(300);
      const first = `queued-state-${crypto.randomUUID()}`;
      const second = `live-state-${crypto.randomUUID()}`;

      const scheduled = await callRPC(ws, "setConnectionMarkerAfterDelay", [
        first
      ]);
      expectSuccessfulResult(scheduled, "scheduled");
      await new Promise((resolve) => setTimeout(resolve, 75));
      const set = await callRPC(ws, "setConnectionMarkerNow", [second]);
      expectSuccessfulResult(set, "set");

      await new Promise((resolve) => setTimeout(resolve, 350));
      const read = await callRPC(ws, "getConnectionMarker");
      expectSuccessfulResult(read, second);
    } finally {
      ws.close();
    }
  });

  it("delivers an older queued send before a live-frame close", async () => {
    const parentName = uniqueName();
    const ws = await connectWS(parentName, uniqueName());
    try {
      const parent = await getAgentByName(env.TestSubAgentParent, parentName);
      await parent.delayNextRootResolution(300);
      const message = `queued-before-live-close-${crypto.randomUUID()}`;
      const delivered = waitForTextMessage(ws, message, 2000);
      const closed = waitForClose(ws, 2000);

      const scheduled = await callRPC(ws, "sendConnectionMessageAfterDelay", [
        message
      ]);
      expectSuccessfulResult(scheduled, "scheduled");
      await new Promise((resolve) => setTimeout(resolve, 75));
      ws.send("close-connection-during-live-frame");

      await expect(delivered).resolves.toBe(message);
      await expect(closed).resolves.toEqual({
        code: 4001,
        reason: "live-frame-close"
      });
    } finally {
      ws.close();
    }
  });

  it("preserves consecutive message order after frame completion", async () => {
    const parentName = uniqueName();
    const ws = await connectWS(parentName, uniqueName());
    try {
      const first = `ordered-first-${crypto.randomUUID()}`;
      const second = `ordered-second-${crypto.randomUUID()}`;
      const delivered = waitForTextMessages(ws, new Set([first, second]));

      const response = await callRPC(ws, "sendConnectionMessagesAfterDelay", [
        [first, second]
      ]);
      expectSuccessfulResult(response, "scheduled");
      await expect(delivered).resolves.toEqual([first, second]);
    } finally {
      ws.close();
    }
  });

  it("reports a failed root-routed connection operation", async () => {
    const parentName = uniqueName();
    const ws = await connectWS(parentName, uniqueName());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const parent = await getAgentByName(env.TestSubAgentParent, parentName);
      await parent.failNextRootResolution();

      const deliveredAfterFailure = `delivered-after-failure-${crypto.randomUUID()}`;
      const delivered = waitForTextMessage(ws, deliveredAfterFailure);
      const response = await callRPC(ws, "sendConnectionMessagesAfterDelay", [
        ["expected-root-resolution-failure", deliveredAfterFailure]
      ]);
      expectSuccessfulResult(response, "scheduled");

      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalledWith(
          "[Agent] Sub-agent connection operation failed:",
          expect.objectContaining({
            connectionId: expect.any(String),
            operation: expect.stringMatching(/^(send|setState|close)$/),
            error: expect.any(Error)
          })
        );
      });
      await expect(delivered).resolves.toBe(deliveredAfterFailure);
    } finally {
      errorSpy.mockRestore();
      ws.close();
    }
  });

  it("preserves the final consecutive state update", async () => {
    const ws = await connectWS(uniqueName(), uniqueName());
    try {
      const first = `state-first-${crypto.randomUUID()}`;
      const second = `state-second-${crypto.randomUUID()}`;
      const scheduled = await callRPC(ws, "setConnectionMarkersAfterDelay", [
        [first, second]
      ]);
      expectSuccessfulResult(scheduled, "scheduled");

      await new Promise((resolve) => setTimeout(resolve, 300));
      const read = await callRPC(ws, "getConnectionMarker");
      expectSuccessfulResult(read, second);
    } finally {
      ws.close();
    }
  });

  it("persists connection state", async () => {
    const ws = await connectWS(uniqueName(), uniqueName());
    try {
      const marker = `delayed-state-${crypto.randomUUID()}`;
      const scheduled = await callRPC(ws, "setConnectionMarkerAfterDelay", [
        marker
      ]);
      expectSuccessfulResult(scheduled, "scheduled");

      await new Promise((resolve) => setTimeout(resolve, 100));
      const read = await callRPC(ws, "getConnectionMarker");
      expectSuccessfulResult(read, marker);
    } finally {
      ws.close();
    }
  });

  it("delivers a final message before a consecutive close", async () => {
    const ws = await connectWS(uniqueName(), uniqueName());
    try {
      const message = `before-close-${crypto.randomUUID()}`;
      const delivered = waitForTextMessage(ws, message);
      const closed = waitForClose(ws);

      const scheduled = await callRPC(ws, "sendThenCloseConnectionAfterDelay", [
        message,
        4000,
        "ordered-close"
      ]);
      expectSuccessfulResult(scheduled, "scheduled");
      await expect(delivered).resolves.toBe(message);
      await expect(closed).resolves.toEqual({
        code: 4000,
        reason: "ordered-close"
      });
    } finally {
      ws.close();
    }
  });

  it("closes the connection", async () => {
    const ws = await connectWS(uniqueName(), uniqueName());
    try {
      const closed = waitForClose(ws);
      const scheduled = await callRPC(ws, "closeConnectionAfterDelay", [
        4000,
        "delayed-close"
      ]);
      expectSuccessfulResult(scheduled, "scheduled");
      await expect(closed).resolves.toEqual({
        code: 4000,
        reason: "delayed-close"
      });
    } finally {
      ws.close();
    }
  });
});
