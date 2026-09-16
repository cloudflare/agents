/**
 * End to end against a real daemon: a real HTTP server on an ephemeral port,
 * a real `ws` socket, a real Cap'n Web session, and the echo engine behind
 * it. Nothing here is mocked, because the parts most likely to break are the
 * seams: the upgrade check, the fence, the stream, and idempotent delivery.
 */
import { afterEach, describe, expect, it } from "vitest";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import WebSocketClient from "ws";
import {
  HARNESS_PROTOCOL_VERSION,
  HARNESS_SECRET_HEADER,
  type HarnessDaemonApi,
  type HarnessWireBatch,
  type HarnessWireFrame
} from "../../../../shared/src/protocol.ts";
import { startDaemon, type DaemonHandle } from "../server.ts";

const SECRET = "test-secret";
const SESSION = "main";

let running: DaemonHandle | undefined;
const closers: (() => void)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await running?.stop(0, "test over");
  running = undefined;
});

async function start(): Promise<DaemonHandle> {
  running = await startDaemon({
    sessionId: SESSION,
    secret: SECRET,
    engineId: "echo",
    engineOptions: {},
    port: 0,
    outboxPath: ":memory:",
    log: () => {},
    // The daemon must not take the test runner down with it.
    exit: () => {}
  });
  return running;
}

function connect(port: number, secret = SECRET): RpcStub<HarnessDaemonApi> {
  const socket = new WebSocketClient(`ws://127.0.0.1:${port}/rpc`, {
    headers: { [HARNESS_SECRET_HEADER]: secret }
  });
  closers.push(() => socket.close());
  // `ws` satisfies the parts of the standard interface Cap'n Web uses.
  return newWebSocketRpcSession<HarnessDaemonApi>(
    socket as unknown as WebSocket
  );
}

/** Read batches until `stop` says the run is over, then return every frame. */
async function readUntil(
  stream: ReadableStream<HarnessWireBatch>,
  stop: (frame: HarnessWireFrame) => boolean
): Promise<readonly HarnessWireFrame[]> {
  const reader = stream.getReader();
  const frames: HarnessWireFrame[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return frames;
      for (const frame of value.frames) {
        frames.push(frame);
        if (stop(frame)) return frames;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

describe("DaemonRoot over Cap'n Web", () => {
  it("answers hello and drives one echo turn to a settlement", async () => {
    const daemon = await start();
    const api = connect(daemon.port);

    const hello = await api.hello({
      protocol: HARNESS_PROTOCOL_VERSION,
      sessionId: SESSION,
      secret: SECRET,
      expectRuntimeId: null
    });
    expect(hello.runtimeId).toBe(daemon.runtimeId);
    expect(hello.engineId).toBe("echo");
    expect(hello.highWaterSeq).toBe(0);
    expect(hello.capabilities).toContain("requests");
    expect(hello.priorExit).toBeNull();

    const stream = await api.subscribe({
      runtimeId: daemon.runtimeId,
      fromSeq: 0,
      previews: true
    });
    const accepted = await api.deliver({
      runtimeId: daemon.runtimeId,
      row: {
        seq: 1,
        key: "op-1",
        operationId: "op-1",
        kind: "prompt",
        payload: { input: "hello", delivery: "queue" }
      }
    });
    expect(accepted.accepted).toBe(true);

    const frames = await readUntil(
      stream,
      (frame) => frame.body.type === "settle"
    );
    const types = frames.map((frame) => frame.body.type);
    expect(types).toEqual(["begin", "message_start", "message_end", "settle"]);
    const settle = frames.at(-1)?.body;
    expect(settle).toMatchObject({
      type: "settle",
      operationId: "op-1",
      settlement: { status: "completed", raw: { echoed: "echo: hello" } }
    });
    expect(frames.every((frame) => frame.operationId === "op-1")).toBe(true);
    expect(frames.map((frame) => frame.seq)).toEqual([1, 2, 3, 4]);
  });

  it("is idempotent on the row key", async () => {
    const daemon = await start();
    const api = connect(daemon.port);
    await api.hello({
      protocol: HARNESS_PROTOCOL_VERSION,
      sessionId: SESSION,
      secret: SECRET,
      expectRuntimeId: null
    });
    const row = {
      seq: 1,
      key: "op-1",
      operationId: "op-1",
      kind: "prompt",
      payload: { input: "hello", delivery: "queue" }
    } as const;
    const first = await api.deliver({ runtimeId: daemon.runtimeId, row });
    const second = await api.deliver({ runtimeId: daemon.runtimeId, row });
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.code).toBe("E_ALREADY_APPLIED");
  });

  it("raises a request and answers it with a reply row", async () => {
    const daemon = await start();
    const api = connect(daemon.port);
    await api.hello({
      protocol: HARNESS_PROTOCOL_VERSION,
      sessionId: SESSION,
      secret: SECRET,
      expectRuntimeId: null
    });
    const stream = await api.subscribe({
      runtimeId: daemon.runtimeId,
      fromSeq: 0,
      previews: false
    });
    await api.deliver({
      runtimeId: daemon.runtimeId,
      row: {
        seq: 1,
        key: "op-1",
        operationId: "op-1",
        kind: "prompt",
        payload: { input: "ask to run ls", delivery: "queue" }
      }
    });
    const opened = await readUntil(
      stream,
      (frame) => frame.body.type === "request_open"
    );
    const request = opened.at(-1)?.body;
    expect(request).toMatchObject({
      type: "request_open",
      request: { requestId: "perm:op-1", type: "permission", action: "Bash" }
    });

    const replied = await api.deliver({
      runtimeId: daemon.runtimeId,
      row: {
        seq: 2,
        key: "perm:op-1",
        operationId: "op-1",
        kind: "reply",
        payload: {
          requestId: "perm:op-1",
          reply: { type: "permission", decision: "allow" },
          by: "client"
        }
      }
    });
    expect(replied.accepted).toBe(true);

    const rest = await readUntil(
      stream,
      (frame) => frame.body.type === "settle"
    );
    const types = rest.map((frame) => frame.body.type);
    expect(types).toContain("request_close");
    expect(types).toContain("extension");
    const unknown = await api.deliver({
      runtimeId: daemon.runtimeId,
      row: {
        seq: 3,
        key: "perm:missing",
        operationId: "op-1",
        kind: "reply",
        payload: {
          requestId: "perm:missing",
          reply: { type: "permission", decision: "allow" },
          by: "client"
        }
      }
    });
    expect(unknown.code).toBe("E_UNKNOWN_REQUEST");
  });

  it("aborts a running turn when an interrupt row is delivered", async () => {
    const daemon = await start();
    const api = connect(daemon.port);
    await api.hello({
      protocol: HARNESS_PROTOCOL_VERSION,
      sessionId: SESSION,
      secret: SECRET,
      expectRuntimeId: null
    });
    const stream = await api.subscribe({
      runtimeId: daemon.runtimeId,
      fromSeq: 0,
      previews: false
    });
    await api.deliver({
      runtimeId: daemon.runtimeId,
      row: {
        seq: 1,
        key: "op-1",
        operationId: "op-1",
        kind: "prompt",
        payload: { input: "slow down", delivery: "queue" }
      }
    });
    await api.deliver({
      runtimeId: daemon.runtimeId,
      row: {
        seq: 2,
        key: "interrupt:op-1",
        operationId: "op-1",
        kind: "interrupt",
        payload: { operationId: "op-1", reason: "the operator said stop" }
      }
    });
    const frames = await readUntil(
      stream,
      (frame) => frame.body.type === "settle"
    );
    expect(frames.at(-1)?.body).toMatchObject({
      type: "settle",
      settlement: {
        status: "aborted",
        stopReason: { type: "interrupted" }
      }
    });
  });

  it("replays from a cursor rather than from the start", async () => {
    const daemon = await start();
    const api = connect(daemon.port);
    await api.hello({
      protocol: HARNESS_PROTOCOL_VERSION,
      sessionId: SESSION,
      secret: SECRET,
      expectRuntimeId: null
    });
    const first = await api.subscribe({
      runtimeId: daemon.runtimeId,
      fromSeq: 0,
      previews: false
    });
    await api.deliver({
      runtimeId: daemon.runtimeId,
      row: {
        seq: 1,
        key: "op-1",
        operationId: "op-1",
        kind: "prompt",
        payload: { input: "hello", delivery: "queue" }
      }
    });
    await readUntil(first, (frame) => frame.body.type === "settle");

    // A second subscribe supersedes the first, which must then fail.
    const second = await api.subscribe({
      runtimeId: daemon.runtimeId,
      fromSeq: 2,
      previews: false
    });
    await expect(first.getReader().read()).rejects.toThrow(/E_SUPERSEDED/);
    const replayed = await readUntil(
      second,
      (frame) => frame.body.type === "settle"
    );
    expect(replayed.map((frame) => frame.seq)).toEqual([3, 4]);
  });

  it("fences a stale runtime id", async () => {
    const daemon = await start();
    const api = connect(daemon.port);
    await api.hello({
      protocol: HARNESS_PROTOCOL_VERSION,
      sessionId: SESSION,
      secret: SECRET,
      expectRuntimeId: null
    });
    await expect(
      api.subscribe({ runtimeId: "someone-else", fromSeq: 0, previews: false })
    ).rejects.toThrow(/E_RUNTIME_FENCED/);
    await expect(
      api.ack({ runtimeId: "someone-else", seq: 1 })
    ).rejects.toThrow(/E_RUNTIME_FENCED/);
  });

  it("refuses a bad protocol and a bad secret", async () => {
    const daemon = await start();
    const api = connect(daemon.port);
    await expect(
      api.hello({
        protocol: HARNESS_PROTOCOL_VERSION + 1,
        sessionId: SESSION,
        secret: SECRET,
        expectRuntimeId: null
      })
    ).rejects.toThrow(/E_PROTOCOL/);
    await expect(
      api.hello({
        protocol: HARNESS_PROTOCOL_VERSION,
        sessionId: SESSION,
        secret: "wrong",
        expectRuntimeId: null
      })
    ).rejects.toThrow(/E_UNAUTHORIZED/);
  });

  it("rejects the upgrade without the secret header", async () => {
    const daemon = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocketClient(`ws://127.0.0.1:${daemon.port}/rpc`);
      socket.on("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
      });
      socket.on("open", () => reject(new Error("the upgrade should not open")));
      socket.on("error", () => {
        // `ws` also reports a socket hangup; the status resolves first.
      });
    });
    expect(status).toBe(401);
  });

  it("serves an unauthenticated health endpoint", async () => {
    const daemon = await start();
    const response = await fetch(`http://127.0.0.1:${daemon.port}/healthz`, {
      method: "HEAD"
    });
    expect(response.status).toBe(200);
  });

  it("accepts a transcript restore and refuses a malformed one", async () => {
    const daemon = await start();
    const api = connect(daemon.port);
    await api.hello({
      protocol: HARNESS_PROTOCOL_VERSION,
      sessionId: SESSION,
      secret: SECRET,
      expectRuntimeId: null
    });
    const entry = {
      type: "assistant",
      uuid: "uuid-1",
      message: { role: "assistant", content: "hi" }
    };
    // The echo engine keeps no transcript, so the restore is simply ignored;
    // what this asserts is that the wire carries it without complaint.
    await expect(
      api.configure({
        runtimeId: daemon.runtimeId,
        engineLog: [
          {
            engineSessionId: "engine-1",
            subpath: null,
            entries: [entry],
            chunk: 0,
            chunks: 2
          },
          {
            engineSessionId: "engine-1",
            subpath: "subagents/agent-1",
            entries: [entry],
            chunk: 1,
            chunks: 2
          }
        ],
        resume: { engineSessionId: "engine-1" }
      })
    ).resolves.toBeUndefined();

    // A malformed chunk is refused rather than half-applied: a hole in a
    // restored transcript is worse than no restore at all.
    await expect(
      api.configure({
        runtimeId: daemon.runtimeId,
        engineLog: [
          {
            engineSessionId: "engine-1",
            subpath: null,
            entries: ["not an entry"],
            chunk: 0,
            chunks: 1
          }
        ]
      })
    ).rejects.toThrow(/E_PROTOCOL/);
    await expect(
      api.configure({
        runtimeId: daemon.runtimeId,
        engineLog: [
          {
            engineSessionId: "engine-1",
            subpath: null,
            entries: [],
            chunk: 3,
            chunks: 1
          }
        ]
      })
    ).rejects.toThrow(/E_PROTOCOL/);

    // The session is unharmed: a turn still runs.
    const stream = await api.subscribe({
      runtimeId: daemon.runtimeId,
      fromSeq: 0,
      previews: false
    });
    await api.deliver({
      runtimeId: daemon.runtimeId,
      row: {
        seq: 1,
        key: "op-1",
        operationId: "op-1",
        kind: "prompt",
        payload: { input: "hello", delivery: "queue" }
      }
    });
    const frames = await readUntil(
      stream,
      (frame) => frame.body.type === "settle"
    );
    expect(frames.at(-1)?.body).toMatchObject({ type: "settle" });
  });

  it("prunes the outbox on ack and reports it on probe", async () => {
    const daemon = await start();
    const api = connect(daemon.port);
    await api.hello({
      protocol: HARNESS_PROTOCOL_VERSION,
      sessionId: SESSION,
      secret: SECRET,
      expectRuntimeId: null
    });
    const stream = await api.subscribe({
      runtimeId: daemon.runtimeId,
      fromSeq: 0,
      previews: false
    });
    await api.deliver({
      runtimeId: daemon.runtimeId,
      row: {
        seq: 1,
        key: "op-1",
        operationId: "op-1",
        kind: "prompt",
        payload: { input: "hello", delivery: "queue" }
      }
    });
    await readUntil(stream, (frame) => frame.body.type === "settle");
    await api.ack({ runtimeId: daemon.runtimeId, seq: 4 });
    const probe = await api.probe();
    expect(probe.runtimeId).toBe(daemon.runtimeId);
    expect(probe.highWaterSeq).toBe(4);
    expect(probe.floorSeq).toBe(5);
    expect(probe.busy).toBe(false);
  });
});
