import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { StreamChunkData } from "../message-builder";
import {
  pumpReply,
  type LiveReply,
  type ReplyEvent,
  type ReplyFrame,
  type ReplyInterruption,
  type ReplyPumpHost,
  type ReplyPumpInput,
  type ReplyRouteOutcome,
  type ReplyStoreContext
} from "../reply-pump";
import { responseSource, type ReplySource } from "../reply-source";
import type {
  ReplyFlushState,
  ReplyStreamLog,
  ReplyStreamResult,
  ReplyStreamStart
} from "../reply-stream";
import { ChatStreamStalledError } from "../stall-watchdog";
import type { ChatResponseResult } from "../lifecycle";
import type { ChatTurnOutcome } from "../wire-types";

/** A stream log that keeps everything in memory and records each call. */
class FakeStreamLog implements ReplyStreamLog {
  readonly calls: string[] = [];
  readonly chunks: string[] = [];
  started: ReplyStreamStart | undefined;
  start(_requestId: string, options?: ReplyStreamStart): string {
    this.started = options;
    this.calls.push("start");
    return "stream-1";
  }
  store(
    _streamId: string,
    _chunk: StreamChunkData,
    body: string,
    _state: ReplyFlushState
  ): number {
    this.chunks.push(body);
    return this.chunks.length - 1;
  }
  finish(_streamId: string, outcome?: ChatTurnOutcome): void {
    this.calls.push(`finish:${outcome}`);
  }
  complete(_streamId: string, outcome?: ChatTurnOutcome): void {
    this.calls.push(`complete:${outcome}`);
  }
  error(): void {
    this.calls.push("error");
  }
  completeStopped(): void {
    this.calls.push("completeStopped");
  }
  completeForRetry(): void {
    this.calls.push("completeForRetry");
  }
  settlePending(_requestId: string, result: ReplyStreamResult): void {
    this.calls.push(`settlePending:${result.status}`);
  }
}

/** A host whose every step records itself in `log`, in order. */
function fakeHost(overrides: Partial<ReplyPumpHost> = {}) {
  const log: string[] = [];
  const frames: ReplyFrame[] = [];
  const events: ReplyEvent[] = [];
  const stored: Array<{ message: UIMessage; context: ReplyStoreContext }> = [];
  const settled: ChatResponseResult[] = [];
  const streams = new FakeStreamLog();
  const state: { live: LiveReply | null; reset: boolean } = {
    live: null,
    reset: false
  };
  const host: ReplyPumpHost = {
    streams,
    send: (frame) => {
      frames.push(frame);
      if (frame.done) log.push(`terminal:${frame.outcome}`);
      else if (frame.error) log.push("error-frame");
    },
    broadcastTranscript: () => void log.push("transcript"),
    emit: (event) => void events.push(event),
    setLive: (reply) => {
      state.live = reply;
    },
    stallTimeoutMs: 0,
    onStall: () => void log.push("onStall"),
    isReset: () => state.reset,
    classify: () => "terminal",
    describeError: (error) =>
      error instanceof Error ? error.message : String(error),
    applyToolUpdate: async (update) =>
      void log.push(`toolUpdate:${update.toolCallId}`),
    settleInterruptedReply: (message) => ({
      ...message,
      metadata: { settled: true }
    }),
    store: async (message, context) => {
      stored.push({ message, context });
      log.push(`store:${context.kind}`);
      return message.id;
    },
    route: async () => "declined",
    settled: async (response) => {
      settled.push(response);
      log.push(`settled:${response.status}`);
    },
    finalized: (rearm) => void log.push(`finalized:${rearm}`),
    ...overrides
  };
  return { host, log, frames, events, stored, settled, streams, state };
}

function source(chunks: StreamChunkData[]): ReplySource {
  return {
    chunks: (async function* () {
      yield* chunks;
    })()
  };
}

function input(overrides: Partial<ReplyPumpInput> = {}): ReplyPumpInput {
  return {
    requestId: "req-1",
    messageId: "msg-1",
    source: source([]),
    ...overrides
  };
}

const textReply: StreamChunkData[] = [
  { type: "start" },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "Hello" },
  { type: "text-end", id: "t" },
  { type: "finish" }
];

describe("pumpReply", () => {
  it("stores each chunk, sends it, stores the reply, then sends the terminal frame", async () => {
    const { host, log, frames, stored, streams } = fakeHost();
    const result = await pumpReply(input({ source: source(textReply) }), host);

    expect(result).toEqual({ status: "completed", messageId: "msg-1" });
    expect(streams.chunks).toHaveLength(5);
    // The `start` chunk names the id the reply is stored under.
    expect(JSON.parse(streams.chunks[0])).toEqual({
      type: "start",
      messageId: "msg-1"
    });
    expect(frames.slice(0, 5).map((f) => f.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(stored[0].message.parts).toMatchObject([
      { type: "text", text: "Hello" }
    ]);
    expect(log).toEqual([
      "store:final",
      "terminal:completed",
      "settled:completed",
      "finalized:true"
    ]);
    expect(streams.calls).toEqual([
      "start",
      "finish:completed",
      "settlePending:completed"
    ]);
  });

  it("names a continuation's message on its chunk frames and strips a provider id", async () => {
    const { host, frames, streams } = fakeHost();
    const extend: UIMessage = {
      id: "earlier",
      role: "assistant",
      parts: [{ type: "text", text: "Before", state: "streaming" }],
      metadata: { createdAt: 1 }
    };
    await pumpReply(
      input({
        continuation: true,
        extend,
        source: source([
          {
            type: "start",
            messageId: "provider-id",
            messageMetadata: { createdAt: 2, model: "m" }
          },
          ...textReply.slice(1)
        ])
      }),
      host
    );

    expect(streams.started).toMatchObject({
      messageId: "earlier",
      continuation: true,
      basePartCount: 1
    });
    expect(JSON.parse(frames[0].body)).toEqual({
      type: "start",
      messageMetadata: { model: "m" }
    });
    expect(frames[0]).toMatchObject({
      continuation: true,
      messageId: "earlier"
    });
    expect(frames.at(-1)).toMatchObject({ done: true, continuation: true });
  });

  it("keeps a continuation's message, its metadata and its closed cut-off part", async () => {
    const { host, stored } = fakeHost();
    await pumpReply(
      input({
        continuation: true,
        extend: {
          id: "earlier",
          role: "assistant",
          parts: [{ type: "text", text: "Before", state: "streaming" }],
          metadata: { createdAt: 1 }
        },
        source: source([
          { type: "start", messageMetadata: { createdAt: 2 } },
          ...textReply.slice(1)
        ])
      }),
      host
    );

    expect(stored[0].message).toMatchObject({
      id: "earlier",
      metadata: { createdAt: 1 },
      parts: [
        { type: "text", text: "Before", state: "done" },
        { type: "text", text: "Hello", state: "done" }
      ]
    });
  });

  it("does not send a provider's replay of a settled tool call (#1404)", async () => {
    const { host, frames } = fakeHost();
    await pumpReply(
      input({
        source: source([
          { type: "tool-input-start", toolCallId: "c1", toolName: "t" },
          {
            type: "tool-input-available",
            toolCallId: "c1",
            toolName: "t",
            input: {}
          },
          { type: "tool-output-available", toolCallId: "c1", output: 1 },
          { type: "tool-input-start", toolCallId: "c1", toolName: "t" },
          {
            type: "tool-input-available",
            toolCallId: "c1",
            toolName: "t",
            input: {}
          }
        ])
      }),
      host
    );

    const sent = frames
      .filter((f) => !f.done)
      .map((f) => (JSON.parse(f.body) as { type: string }).type);
    expect(sent).toEqual([
      "tool-input-start",
      "tool-input-available",
      "tool-output-available"
    ]);
  });

  it("hands a tool result for an earlier message to the host", async () => {
    const { host, log } = fakeHost();
    await pumpReply(
      input({
        source: source([
          { type: "tool-output-available", toolCallId: "earlier", output: 1 }
        ])
      }),
      host
    );
    expect(log).toContain("toolUpdate:earlier");
  });

  it("holds an in-band error's frame until the reply is stored, and sends one error frame", async () => {
    const { host, log, frames, events } = fakeHost();
    const errors: string[] = [];
    const result = await pumpReply(
      input({
        source: source([
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "Part" },
          { type: "error", errorText: "provider failed" },
          { type: "text-delta", id: "t", delta: "ignored" }
        ]),
        sink: {
          chunk: async () => {},
          done: async () => void errors.push("done"),
          error: async (message) => void errors.push(message),
          interrupted: async () => {}
        }
      }),
      host
    );

    expect(result).toEqual({ status: "error", error: "provider failed" });
    expect(log).toEqual([
      "store:final",
      "error-frame",
      "terminal:error",
      "settled:error",
      "finalized:true"
    ]);
    expect(frames.filter((f) => f.error)).toHaveLength(1);
    expect(frames.at(-1)).toMatchObject({ done: true, body: "" });
    expect(events.map((e) => e.type)).toEqual([
      "message:error",
      "chat:request:failed"
    ]);
    expect(errors).toEqual(["provider failed"]);
  });

  it("sends one error frame, the terminal one, for a thrown error", async () => {
    const { host, frames } = fakeHost();
    const result = await pumpReply(
      input({
        source: {
          chunks: (async function* () {
            yield { type: "text-start", id: "t" } as StreamChunkData;
            throw new Error("read failed");
          })()
        }
      }),
      host
    );
    expect(result).toEqual({ status: "error", error: "read failed" });
    expect(frames.filter((f) => f.error)).toEqual([
      expect.objectContaining({
        done: true,
        outcome: "error",
        body: "read failed"
      })
    ]);
  });

  it("routes an in-band error the host calls transient into recovery", async () => {
    const routes: ReplyInterruption[] = [];
    let interrupted = 0;
    const { host, log, frames, settled, streams } = fakeHost({
      classify: (_error, inBand) => (inBand ? "transient" : "terminal"),
      route: async (interruption) => {
        routes.push(interruption);
        await interruption.keepPartial();
        return "scheduled";
      }
    });
    const result = await pumpReply(
      input({
        source: source([
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "Part" },
          { type: "error", errorText: "overloaded" }
        ]),
        sink: {
          chunk: async () => {},
          done: async () => {},
          error: async () => {},
          interrupted: async () => void interrupted++
        }
      }),
      host
    );

    expect(result).toEqual({ status: "aborted", reason: "interrupted" });
    expect(routes[0].backoff).toBe(true);
    expect(log).toEqual([
      "store:partial",
      "terminal:recovering",
      "finalized:false"
    ]);
    expect(frames.filter((f) => f.error)).toEqual([]);
    expect(settled).toEqual([]);
    expect(interrupted).toBe(1);
    expect(streams.calls).toContain("complete:recovering");
  });

  it("routes a stall without backoff and tells the host to abort the turn", async () => {
    const routes: ReplyInterruption[] = [];
    const { host, log, events } = fakeHost({
      stallTimeoutMs: 10,
      route: async (interruption) => {
        routes.push(interruption);
        return "exhausted";
      }
    });
    const result = await pumpReply(
      input({
        source: {
          chunks: (async function* () {
            yield { type: "text-start", id: "t" } as StreamChunkData;
            await new Promise(() => {});
          })()
        }
      }),
      host
    );

    expect(result).toEqual({ status: "aborted", reason: "interrupted" });
    expect(routes[0].error).toBeInstanceOf(ChatStreamStalledError);
    expect(routes[0].backoff).toBe(false);
    expect(log).toEqual(["onStall", "finalized:false"]);
    expect(events).toEqual([
      { type: "chat:stream:stalled", requestId: "req-1", timeoutMs: 10 }
    ]);
  });

  it("ends a reply stopped while it was routed as aborted, and runs its hook", async () => {
    const route = async (
      interruption: ReplyInterruption
    ): Promise<ReplyRouteOutcome> => {
      await interruption.keepPartial();
      return "stopped";
    };
    const { host, log, streams } = fakeHost({
      classify: () => "transient",
      route
    });
    const result = await pumpReply(
      input({
        source: {
          chunks: (async function* () {
            yield { type: "text-start", id: "t" } as StreamChunkData;
            throw new Error("connection reset");
          })()
        }
      }),
      host
    );
    expect(result).toEqual({ status: "aborted" });
    expect(streams.calls).toContain("completeStopped");
    expect(log).toEqual([
      "store:partial",
      "terminal:aborted",
      "settled:aborted",
      "finalized:true"
    ]);
  });

  it("ends a stopped reply aborted and settles its cut-off calls", async () => {
    const controller = new AbortController();
    const { host, stored, frames } = fakeHost();
    const result = await pumpReply(
      input({
        signal: controller.signal,
        source: {
          chunks: (async function* () {
            yield { type: "text-start", id: "t" } as StreamChunkData;
            yield {
              type: "text-delta",
              id: "t",
              delta: "Hi"
            } as StreamChunkData;
            controller.abort();
            yield {
              type: "text-delta",
              id: "t",
              delta: "!"
            } as StreamChunkData;
          })()
        }
      }),
      host
    );

    expect(result).toEqual({ status: "aborted" });
    expect(stored[0].message.metadata).toEqual({ settled: true });
    expect(stored[0].context.result).toEqual({ status: "aborted" });
    expect(frames.at(-1)).toMatchObject({ done: true, outcome: "aborted" });
  });

  it("cancels a source that does not listen to the turn's signal", async () => {
    const controller = new AbortController();
    let cancelled = false;
    let wake!: () => void;
    const { host } = fakeHost();
    const pending = pumpReply(
      input({
        signal: controller.signal,
        source: {
          chunks: (async function* () {
            yield { type: "text-start", id: "t" } as StreamChunkData;
            await new Promise<void>((resolve) => (wake = resolve));
          })(),
          cancel: () => {
            cancelled = true;
            wake();
          }
        }
      }),
      host
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    expect(await pending).toEqual({ status: "aborted" });
    expect(cancelled).toBe(true);
  });

  it("returns an overflow to the host to retry, storing and sending nothing", async () => {
    const { host, log, streams, stored } = fakeHost({
      classify: () => "overflow"
    });
    const result = await pumpReply(
      input({
        overflowRetry: true,
        source: source([
          { type: "text-start", id: "t" },
          { type: "error", errorText: "context too long" }
        ])
      }),
      host
    );
    expect(result).toMatchObject({
      status: "overflow_retry",
      error: "context too long"
    });
    expect(stored).toEqual([]);
    expect(log).toEqual(["finalized:false"]);
    expect(streams.calls).toContain("completeForRetry");
  });

  it("stores nothing and runs no hook for a chat reset under the reply", async () => {
    const { host, state, log, stored } = fakeHost();
    state.reset = true;
    const result = await pumpReply(input({ source: source(textReply) }), host);
    expect(result).toEqual({ status: "aborted" });
    expect(stored).toEqual([]);
    expect(log).toEqual(["terminal:completed", "finalized:true"]);
  });

  it("sends the transcript after the terminal frame when the reply held nothing to store", async () => {
    const { host, log } = fakeHost({
      store: async () => undefined
    });
    await pumpReply(
      input({
        source: source([{ type: "reasoning-start", id: "r" }])
      }),
      host
    );
    expect(log).toEqual([
      "terminal:completed",
      "transcript",
      "settled:completed",
      "finalized:true"
    ]);
  });

  it("stores the reply again when a tool result lands during the write", async () => {
    let live: LiveReply | null = null;
    let writes = 0;
    const { host, stored } = fakeHost({
      setLive: (reply) => {
        live = reply;
      },
      store: async (message, context) => {
        stored.push({ message, context });
        if (writes++ === 0) {
          const part = live!.accumulator.parts[0] as Record<string, unknown>;
          part.state = "output-available";
          part.output = "late";
          live!.changed();
        }
        return message.id;
      }
    });
    await pumpReply(
      input({
        source: source([
          {
            type: "tool-input-available",
            toolCallId: "c1",
            toolName: "t",
            input: {}
          }
        ])
      }),
      host
    );
    expect(stored.map((s) => s.context.kind)).toEqual(["final", "again"]);
    expect(stored[1].message.parts[0]).toMatchObject({ output: "late" });
  });

  it("fails a reply whose store throws, with its hook", async () => {
    const { host, log, frames } = fakeHost({
      store: async () => {
        throw new Error("disk full");
      }
    });
    const result = await pumpReply(input({ source: source(textReply) }), host);
    expect(result).toEqual({ status: "error", error: "disk full" });
    expect(frames.at(-1)).toMatchObject({
      done: true,
      error: true,
      outcome: "error",
      body: "disk full"
    });
    expect(log).toEqual([
      "terminal:error",
      "transcript",
      "settled:error",
      "finalized:true"
    ]);
  });

  it("marks the live reply ended while it is stored", async () => {
    let seen: boolean | undefined;
    let live: LiveReply | null = null;
    const { host } = fakeHost({
      setLive: (reply) => {
        live = reply;
      },
      store: async (message) => {
        seen = live?.ended;
        return message.id;
      }
    });
    await pumpReply(input({ source: source(textReply) }), host);
    expect(seen).toBe(true);
    expect(live).toBeNull();
  });
});

describe("responseSource", () => {
  function response(parts: string[], contentType: string) {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      }
    });
    return {
      response: new Response(null, {
        headers: { "content-type": contentType }
      }),
      body
    };
  }

  async function read(source: ReplySource) {
    const chunks: StreamChunkData[] = [];
    for await (const chunk of source.chunks) chunks.push(chunk);
    return chunks;
  }

  it("reads a data line split across two reads", async () => {
    const { response: r, body } = response(
      [
        'data: {"type":"text-start","id":"t"}\n\ndata: {"type":"text-del',
        'ta","id":"t","delta":"Hi"}\n\ndata: [DONE]\n\n'
      ],
      "text/event-stream"
    );
    expect(await read(responseSource(r, body, "req"))).toEqual([
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Hi" }
    ]);
  });

  it("skips a line that is not JSON", async () => {
    const { response: r, body } = response(
      ['data: nope\n\ndata: {"type":"finish"}\n\n'],
      "text/event-stream"
    );
    expect(await read(responseSource(r, body, "req"))).toEqual([
      { type: "finish" }
    ]);
  });

  it("reads plain text as one text part under the request id", async () => {
    const { response: r, body } = response(["Hel", "lo"], "text/plain");
    expect(await read(responseSource(r, body, "req"))).toEqual([
      { type: "text-start", id: "req" },
      { type: "text-delta", id: "req", delta: "Hel" },
      { type: "text-delta", id: "req", delta: "lo" },
      { type: "text-end", id: "req" }
    ]);
  });

  it("reads an empty plain-text body as no reply", async () => {
    const { response: r, body } = response([], "text/plain");
    expect(await read(responseSource(r, body, "req"))).toEqual([]);
  });
});
