import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { getAgentByName, type RPCRequest, type RPCResponse } from "../index";
import { MessageType } from "../types";

function uniqueName(): string {
  return `rpc-bridge-test-${crypto.randomUUID()}`;
}

async function connectWS(
  parent: string,
  child: string,
  pk?: string
): Promise<WebSocket> {
  const path =
    `/agents/test-sub-agent-parent/${parent}` +
    `/sub/slow-reply-sub-agent/${child}` +
    (pk ? `?_pk=${pk}` : "");
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

  it("ends a sub-agent stream at a chunk over the frame limit", async () => {
    const ws = await connectWS(uniqueName(), uniqueName());
    try {
      const id = `huge-${crypto.randomUUID()}`;
      const frames: RPCResponse[] = [];
      ws.addEventListener("message", (event: MessageEvent) => {
        try {
          const frame = JSON.parse(event.data as string) as RPCResponse;
          if (frame.type === MessageType.RPC && frame.id === id) {
            frames.push(frame);
          }
        } catch {
          // not JSON
        }
      });
      ws.send(
        JSON.stringify({
          type: MessageType.RPC,
          id,
          method: "hugeStream",
          args: []
        } satisfies RPCRequest)
      );
      await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(2), {
        timeout: 10_000
      });
      // Anything after the error would have arrived by now.
      await callRPC(ws, "fastEcho", ["after"]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(frames).toHaveLength(2);
      expect(frames[0]).toMatchObject({ success: true, result: "small" });
      expect(frames[1]).toMatchObject({ success: false });
      expect(String((frames[1] as { error?: string }).error)).toContain(
        "message limit"
      );
    } finally {
      ws.close();
    }
  }, 20_000);

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

  it("reaches a client that reconnected with its id before the old socket closed (#2709)", async () => {
    // PartySocket reuses its `_pk` on a reconnect, and the new socket can
    // arrive before the root sees the old one close.
    const parent = uniqueName();
    const child = uniqueName();
    const pk = crypto.randomUUID();
    const old = await connectWS(parent, child, pk);
    const ws = await connectWS(parent, child, pk);
    try {
      const message = "after-reconnect";
      const delivered = waitForTextMessage(ws, message);
      const response = await callRPC(ws, "sendConnectionMessageAfterDelay", [
        message
      ]);
      expectSuccessfulResult(response, "scheduled");
      await expect(delivered).resolves.toBe(message);

      // Once the root has handled the old socket's close, the sub-agent
      // still has the client: its broadcast reaches the new socket.
      const parentStub = await getAgentByName(env.TestSubAgentParent, parent);
      old.close();
      await vi.waitFor(async () => {
        expect(await parentStub.subAgentClosesHandledForTest()).toBe(1);
      });
      const broadcast = waitForTextMessage(ws, "after-old-close");
      await parentStub.broadcastFromSubAgentDetached(child, [
        "after-old-close"
      ]);
      await expect(broadcast).resolves.toBe("after-old-close");
    } finally {
      ws.close();
      old.close();
    }
  });

  it("tells a sub-agent its socket closed while a socket to its child has the same id", async () => {
    const parent = uniqueName();
    const child = uniqueName();
    const pk = crypto.randomUUID();
    const base = `/agents/test-sub-agent-parent/${parent}/sub/broadcast-sub-agent/${child}`;
    const open = async (path: string) => {
      const response = await exports.default.fetch(
        `http://example.com${path}?_pk=${pk}`,
        { headers: { Upgrade: "websocket" } }
      );
      expect(response.status).toBe(101);
      const ws = response.webSocket as WebSocket;
      ws.accept();
      return ws;
    };
    const own = await open(base);
    const nested = await open(
      `${base}/sub/broadcast-sub-agent/${uniqueName()}`
    );
    const parentStub = await getAgentByName(env.TestSubAgentParent, parent);
    try {
      own.close();
      await vi.waitFor(async () => {
        expect(await parentStub.subAgentClosesHandledForTest()).toBe(1);
      });
      expect(await parentStub.subAgentClosedConnectionIds(child)).toEqual([pk]);
    } finally {
      nested.close();
      own.close();
    }
  });

  it("keeps a sub-agent's sends off another sub-agent's socket with the same id", async () => {
    // A client picks its `_pk`, so two sub-agents can each have a socket
    // with the same id: each one's frames are its own.
    const parent = uniqueName();
    const pk = crypto.randomUUID();
    const other = await connectWS(parent, uniqueName(), pk);
    const ws = await connectWS(parent, uniqueName(), pk);
    const leaked: string[] = [];
    other.addEventListener("message", (event: MessageEvent) => {
      if (event.data === "only-mine") leaked.push(event.data as string);
    });
    try {
      const delivered = waitForTextMessage(ws, "only-mine");
      expectSuccessfulResult(
        await callRPC(ws, "sendConnectionMessageAfterDelay", ["only-mine"]),
        "scheduled"
      );
      await expect(delivered).resolves.toBe("only-mine");
      // Sent after the other socket would have got it: the same root call.
      const after = waitForTextMessage(other, "after");
      expectSuccessfulResult(
        await callRPC(other, "sendConnectionMessageAfterDelay", ["after"]),
        "scheduled"
      );
      await after;
      expect(leaked).toEqual([]);
    } finally {
      ws.close();
      other.close();
    }
  });

  it("delivers a live-frame send before a later detached send", async () => {
    const parentName = uniqueName();
    const childName = uniqueName();
    const ws = await connectWS(parentName, childName);
    try {
      const parent = await getAgentByName(env.TestSubAgentParent, parentName);
      const live = `live-first-${crypto.randomUUID()}`;
      const detached = `detached-second-${crypto.randomUUID()}`;
      const delivered = waitForTextMessages(
        ws,
        new Set([live, detached]),
        2000
      );

      await parent.forwardLiveThenDetachedMessages(childName, live, detached);

      await expect(delivered).resolves.toEqual([live, detached]);
    } finally {
      ws.close();
    }
  });

  it("reports a failed live-frame connection operation", async () => {
    const ws = await connectWS(uniqueName(), uniqueName());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sent = await callRPC(ws, "sendDetachedConnectionMessageNow");
      expectSuccessfulResult(sent, "sent");

      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalledWith(
          "[Agent] Sub-agent connection operation failed:",
          expect.objectContaining({
            connectionId: expect.any(String),
            operation: "send",
            error: expect.any(Error)
          })
        );
      });
    } finally {
      errorSpy.mockRestore();
      ws.close();
    }
  });

  it("reports a failed live-bridge broadcast", async () => {
    const parentName = uniqueName();
    const ws = await connectWS(parentName, uniqueName());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const parent = await getAgentByName(env.TestSubAgentParent, parentName);
      await parent.failNextSubAgentBroadcast();

      const broadcast = await callRPC(ws, "broadcastMessageNow", [
        "expected-broadcast-forwarding-failure"
      ]);
      expectSuccessfulResult(broadcast, "broadcast");

      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalledWith(
          "[Agent] Sub-agent broadcast operation failed:",
          expect.objectContaining({
            operation: "broadcast",
            error: expect.any(Error)
          })
        );
      });
    } finally {
      errorSpy.mockRestore();
      ws.close();
    }
  });

  it("keeps a live-frame send behind an older queued send", async () => {
    const parentName = uniqueName();
    const ws = await connectWS(parentName, uniqueName());
    try {
      const parent = await getAgentByName(env.TestSubAgentParent, parentName);
      onTestFinished(() => parent.releaseConnectionOperationForTest());
      const first = `queued-first-${crypto.randomUUID()}`;
      await parent.holdNextConnectionOperationForTest("send", first);
      const second = `live-second-${crypto.randomUUID()}`;
      const delivered = waitForTextMessages(ws, new Set([first, second]), 5000);

      const scheduled = await callRPC(ws, "sendConnectionMessageAfterDelay", [
        first
      ]);
      expectSuccessfulResult(scheduled, "scheduled");
      // The detached send is at the root, held: queued, not delivered.
      await vi.waitFor(async () => {
        expect(await parent.isConnectionOperationHeldForTest()).toBe(true);
      });
      // The live frame's send queues behind it; the frame's reply does not.
      const sent = await callRPC(ws, "sendConnectionMessageNow", [second]);
      expectSuccessfulResult(sent, "sent");
      await parent.releaseConnectionOperationForTest();

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
      onTestFinished(() => parent.releaseConnectionOperationForTest());
      const first = `queued-state-${crypto.randomUUID()}`;
      await parent.holdNextConnectionOperationForTest("setState", first);
      const second = `live-state-${crypto.randomUUID()}`;

      const scheduled = await callRPC(ws, "setConnectionMarkerAfterDelay", [
        first
      ]);
      expectSuccessfulResult(scheduled, "scheduled");
      // The detached update is at the root, held: queued, not applied.
      await vi.waitFor(async () => {
        expect(await parent.isConnectionOperationHeldForTest()).toBe(true);
      });
      const set = await callRPC(ws, "setConnectionMarkerNow", [second]);
      expectSuccessfulResult(set, "set");
      await parent.releaseConnectionOperationForTest();

      // The root applied both, the queued one first.
      const markers = async () =>
        JSON.stringify(await parent.appliedConnectionStatesForTest());
      await vi.waitFor(async () => {
        const applied = await markers();
        expect(applied.includes(first) && applied.includes(second)).toBe(true);
      });
      const applied = await markers();
      expect(applied.indexOf(first)).toBeLessThan(applied.indexOf(second));
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
      onTestFinished(() => parent.releaseConnectionOperationForTest());
      const message = `queued-before-live-close-${crypto.randomUUID()}`;
      await parent.holdNextConnectionOperationForTest("send", message);
      const delivered = waitForTextMessage(ws, message, 5000);
      const closed = waitForClose(ws, 5000);
      // Awaited below; marked handled now, so an early failure of the RPC
      // in between reports once, not again as an unhandled rejection.
      void delivered.catch(() => {});
      void closed.catch(() => {});

      const scheduled = await callRPC(ws, "sendConnectionMessageAfterDelay", [
        message
      ]);
      expectSuccessfulResult(scheduled, "scheduled");
      // The detached send is at the root, held: queued, not delivered.
      await vi.waitFor(async () => {
        expect(await parent.isConnectionOperationHeldForTest()).toBe(true);
      });
      const closing = await callRPC(ws, "closeConnectionNow", [
        4001,
        "live-frame-close"
      ]);
      expectSuccessfulResult(closing, "closing");
      await parent.releaseConnectionOperationForTest();

      await expect(delivered).resolves.toBe(message);
      await expect(closed).resolves.toEqual({
        code: 4001,
        reason: "live-frame-close"
      });
    } finally {
      ws.close();
    }
  });

  it("keeps a live-frame broadcast ahead of a later direct send", async () => {
    const ws = await connectWS(uniqueName(), uniqueName());
    try {
      const broadcast = `live-broadcast-${crypto.randomUUID()}`;
      const direct = `live-direct-${crypto.randomUUID()}`;
      const delivered = waitForTextMessages(ws, new Set([broadcast, direct]));

      const response = await callRPC(ws, "broadcastThenSendNow", [
        broadcast,
        direct
      ]);
      expectSuccessfulResult(response, "sent");
      await expect(delivered).resolves.toEqual([broadcast, direct]);
    } finally {
      ws.close();
    }
  });

  it("keeps a broadcast queued behind a send ahead of the next send (#2055)", async () => {
    const ws = await connectWS(uniqueName(), uniqueName());
    try {
      const first = `queued-first-${crypto.randomUUID()}`;
      const broadcast = `queued-broadcast-${crypto.randomUUID()}`;
      const direct = `queued-direct-${crypto.randomUUID()}`;
      const delivered = waitForTextMessages(
        ws,
        new Set([first, broadcast, direct])
      );

      const response = await callRPC(ws, "sendBroadcastSendNow", [
        first,
        broadcast,
        direct
      ]);
      expectSuccessfulResult(response, "sent");
      await expect(delivered).resolves.toEqual([first, broadcast, direct]);
    } finally {
      ws.close();
    }
  });

  it("keeps a send after a queued broadcast out of an older open send batch (#2055)", async () => {
    const ws = await connectWS(uniqueName(), uniqueName());
    try {
      const ids = ["first", "second", "broadcast", "direct"].map(
        (name) => `batched-${name}-${crypto.randomUUID()}`
      );
      const delivered = waitForTextMessages(ws, new Set(ids));

      const response = await callRPC(ws, "sendTwiceBroadcastSendNow", ids);
      expectSuccessfulResult(response, "sent");
      await expect(delivered).resolves.toEqual(ids);
    } finally {
      ws.close();
    }
  });

  it("hands a facet its frames in send order when one waits on a slow facet init (F11)", async () => {
    const parentName = uniqueName();
    const path =
      `/agents/test-sub-agent-parent/${parentName}` +
      `/sub/counter-sub-agent/${uniqueName()}`;
    const response = await exports.default.fetch(`http://example.com${path}`, {
      headers: { Upgrade: "websocket" }
    });
    const ws = response.webSocket as WebSocket;
    ws.accept();
    try {
      // The facet is up once a first frame comes back.
      const warm = waitForTextMessage(ws, "seen:order:warm", 5000);
      ws.send("order:warm");
      await warm;
      // The next frame's facet init is slow, as a facet still starting is.
      const parent = await getAgentByName(env.TestSubAgentParent, parentName);
      await parent.delayFacetInitForTest(1, 200);
      const sent = Array.from({ length: 5 }, (_, i) => `order:${i}`);
      const delivered = waitForTextMessages(
        ws,
        new Set(sent.map((frame) => `seen:${frame}`)),
        5000
      );
      for (const frame of sent) ws.send(frame);
      await expect(delivered).resolves.toEqual(
        sent.map((frame) => `seen:${frame}`)
      );
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

  it("sends a burst of messages from a live frame in at most one root call (#2820)", async () => {
    const parentName = uniqueName();
    const ws = await connectWS(parentName, uniqueName());
    try {
      const parent = await getAgentByName(env.TestSubAgentParent, parentName);
      const before = await parent.subAgentConnectionSendCallCount();
      const messages = Array.from(
        { length: 20 },
        (_, index) => `live-burst-${index}-${crypto.randomUUID()}`
      );
      const delivered = waitForTextMessages(ws, new Set(messages));

      const response = await callRPC(ws, "sendConnectionMessagesNow", [
        messages
      ]);
      expectSuccessfulResult(response, "sent");

      await expect(delivered).resolves.toEqual(messages);
      expect(
        (await parent.subAgentConnectionSendCallCount()) - before
      ).toBeLessThanOrEqual(1);
    } finally {
      ws.close();
    }
  });

  it("sends a burst of messages after frame completion in one root call (#2820)", async () => {
    const parentName = uniqueName();
    const ws = await connectWS(parentName, uniqueName());
    try {
      const parent = await getAgentByName(env.TestSubAgentParent, parentName);
      const before = await parent.subAgentConnectionSendCallCount();
      const messages = Array.from(
        { length: 20 },
        (_, index) => `detached-burst-${index}-${crypto.randomUUID()}`
      );
      const delivered = waitForTextMessages(ws, new Set(messages));

      const response = await callRPC(ws, "sendConnectionMessagesAfterDelay", [
        messages
      ]);
      expectSuccessfulResult(response, "scheduled");

      await expect(delivered).resolves.toEqual(messages);
      expect((await parent.subAgentConnectionSendCallCount()) - before).toBe(1);
    } finally {
      ws.close();
    }
  });

  it("starts a new root call rather than grow a batch past its size limit", async () => {
    const parentName = uniqueName();
    const ws = await connectWS(parentName, uniqueName());
    try {
      const parent = await getAgentByName(env.TestSubAgentParent, parentName);
      const before = await parent.subAgentConnectionSendCallCount();
      const messages = ["a", "b"].map((prefix) =>
        `${prefix}-${crypto.randomUUID()}-`.padEnd(600_000, "x")
      );
      const delivered = waitForTextMessages(ws, new Set(messages), 5000);

      const response = await callRPC(ws, "sendConnectionMessagesAfterDelay", [
        messages
      ]);
      expectSuccessfulResult(response, "scheduled");

      await expect(delivered).resolves.toEqual(messages);
      expect((await parent.subAgentConnectionSendCallCount()) - before).toBe(2);
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

describe("facet broadcasts outside a client frame (issue #2252)", () => {
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it("does not call the root when the sub-agent has no connections", async () => {
    const parent = await getAgentByName(env.TestSubAgentParent, uniqueName());
    await parent.broadcastFromSubAgentDetached(uniqueName(), ["a", "b", "c"]);
    await sleep(100);
    expect(await parent.subAgentBroadcastCallCount()).toBe(0);
  });

  it("does not call the root when every connection is excluded", async () => {
    const parentName = uniqueName();
    const ws = await connectWS(parentName, uniqueName());
    const received: unknown[] = [];
    ws.addEventListener("message", (event) => {
      received.push(event.data);
    });
    try {
      const parent = await getAgentByName(env.TestSubAgentParent, parentName);
      const before = await parent.subAgentBroadcastCallCount();
      const message = `excluded-${crypto.randomUUID()}`;

      const scheduled = await callRPC(ws, "broadcastMessagesAfterDelay", [
        [message],
        true
      ]);
      expectSuccessfulResult(scheduled, "scheduled");
      await sleep(150);

      expect(await parent.subAgentBroadcastCallCount()).toBe(before);
      expect(received).not.toContain(message);
    } finally {
      ws.close();
    }
  });

  it("makes one root call per broadcast to a connected client", async () => {
    const parentName = uniqueName();
    const ws = await connectWS(parentName, uniqueName());
    try {
      const parent = await getAgentByName(env.TestSubAgentParent, parentName);
      const before = await parent.subAgentBroadcastCallCount();
      const messages = [
        `first-${crypto.randomUUID()}`,
        `second-${crypto.randomUUID()}`
      ];
      const delivered = waitForTextMessages(ws, new Set(messages));

      const scheduled = await callRPC(ws, "broadcastMessagesAfterDelay", [
        messages
      ]);
      expectSuccessfulResult(scheduled, "scheduled");

      await expect(delivered).resolves.toEqual(messages);
      expect(await parent.subAgentBroadcastCallCount()).toBe(before + 2);
    } finally {
      ws.close();
    }
  });

  it("still reaches a root-held client after the sub-agent restarts", async () => {
    const parentName = uniqueName();
    const childName = uniqueName();
    const ws = await connectWS(parentName, childName);
    try {
      const parent = await getAgentByName(env.TestSubAgentParent, parentName);
      await parent.abortSlowReplySubAgent(childName);

      const message = `after-restart-${crypto.randomUUID()}`;
      const delivered = waitForTextMessage(ws, message);
      await parent.broadcastFromSubAgentDetached(childName, [message]);
      await expect(delivered).resolves.toBe(message);
    } finally {
      ws.close();
    }
  });

  it("starts an evicted root before it serves a sub-agent call", async () => {
    const name = uniqueName();
    await getAgentByName(env.TestSubAgentParent, name);
    const stub = env.TestSubAgentParent.get(
      env.TestSubAgentParent.idFromName(name)
    );
    await evictDurableObject(stub);

    await (
      stub as unknown as {
        _cf_subAgentConnectionMetas(ownerPath: unknown[]): Promise<unknown>;
      }
    )._cf_subAgentConnectionMetas([
      { className: "TestSubAgentParent", name },
      { className: "SlowReplySubAgent", name: "absent" }
    ]);

    await expect(
      runInDurableObject(stub, (instance) => instance.startsInThisInstance)
    ).resolves.toBe(1);
  });
});
