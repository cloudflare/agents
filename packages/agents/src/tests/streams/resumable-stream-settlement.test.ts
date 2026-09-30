import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Connection } from "../../index";
import { ResumableStream } from "../../chat/resumable-stream";
import type { StreamBenchObject } from "../capabilities/streams-bench";

function createAdapter(
  instance: StreamBenchObject,
  sql: SqlStorage
): ResumableStream {
  return new ResumableStream(
    instance.streams,
    <T>(
      strings: TemplateStringsArray,
      ...values: (string | number | boolean | null)[]
    ): T[] =>
      // SAFETY: ResumableStream owns the SQL schema and each query's row type.
      [...sql.exec(strings.join("?"), ...values)] as T[]
  );
}

describe("ResumableStream settlement", () => {
  it("keeps the cutover retryable when persist throws", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject, ctx) => {
      const stream = createAdapter(instance, ctx.storage.sql);
      const id = stream.start("rollback-request");
      stream.finish(id);
      expect(stream.pendingCutoverId).toBe(id);
      expect(() =>
        stream.cutover(id, () => {
          throw new Error("persist failed");
        })
      ).toThrow("persist failed");
      // The settlement transaction rolled back with the persist, and the
      // in-memory pending marker still matches the durable `streaming` row.
      expect(stream.getStreamMetadata(id)?.status).toBe("streaming");
      expect(stream.pendingCutoverId).toBe(id);
      stream.cutover(id, () => {});
      expect(stream.pendingCutoverId).toBeNull();
      expect(stream.getStreamMetadata(id)).toBeNull();
    });
  });

  it("keeps finalizePending retryable when settlement throws", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject, ctx) => {
      const stream = createAdapter(instance, ctx.storage.sql);
      const id = stream.start("finalize-request");
      stream.finish(id);
      // SAFETY: the test injects one settlement failure through the real ops
      // seam; ResumableStream owns no other path to the settle write.
      const internals = stream as unknown as {
        ops: { settle: (...args: unknown[]) => boolean };
      };
      const settle = internals.ops.settle.bind(internals.ops);
      let failNext = true;
      internals.ops.settle = (...args: unknown[]) => {
        if (failNext) {
          failNext = false;
          throw new Error("settle failed");
        }
        return settle(...args);
      };
      expect(() => stream.finalizePending()).toThrow("settle failed");
      // The pending marker must not claim more progress than the durable row.
      expect(stream.pendingCutoverId).toBe(id);
      expect(stream.getStreamMetadata(id)?.status).toBe("streaming");
      stream.finalizePending();
      expect(stream.pendingCutoverId).toBeNull();
      expect(stream.getStreamMetadata(id)?.status).toBe("completed");
    });
  });

  it("reclaims discard:false rows on the next start", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject, ctx) => {
      const stream = createAdapter(instance, ctx.storage.sql);
      const child = stream.start("child-request");
      stream.cutover(child, () => {}, { discard: false });
      expect(stream.getStreamMetadata(child)?.status).toBe("completed");
      expect(stream.reclaim()).toBe(1);
      expect(stream.getStreamMetadata(child)).toBeNull();
    });
  });
});

describe("ResumableStream originating message ids (#2280)", () => {
  function collectingConnection(frames: Record<string, unknown>[]) {
    return {
      id: "c1",
      send: (message: string) => {
        frames.push(JSON.parse(message) as Record<string, unknown>);
      }
    } as unknown as Connection;
  }

  it("echoes them on the replayed terminal of a completed stream", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject, ctx) => {
      const stream = createAdapter(instance, ctx.storage.sql);
      const id = stream.start("req-done", { originMessageIds: ["m1", "m2"] });
      stream.storeChunk(
        id,
        JSON.stringify({ type: "text-delta", delta: "hi" })
      );
      stream.complete(id);
      expect(stream.getOriginMessageIds("req-done")).toEqual(["m1", "m2"]);

      const frames: Record<string, unknown>[] = [];
      expect(
        stream.replayCompletedChunksByRequestId(
          collectingConnection(frames),
          "req-done"
        )
      ).toBe(true);
      expect(frames.at(0)?.messageIds).toBeUndefined();
      expect(frames.at(-1)).toMatchObject({
        done: true,
        replay: true,
        messageIds: ["m1", "m2"]
      });
    });
  });

  it("echoes them on the terminal of an orphaned stream", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject, ctx) => {
      const first = createAdapter(instance, ctx.storage.sql);
      const id = first.start("req-orphan", { originMessageIds: ["m3"] });
      first.storeChunk(id, JSON.stringify({ type: "text-delta", delta: "x" }));
      first.flushBuffer();

      const restored = createAdapter(instance, ctx.storage.sql);
      restored.restore();
      const frames: Record<string, unknown>[] = [];
      expect(
        restored.replayChunks(collectingConnection(frames), "req-orphan")
      ).toBe(id);
      expect(frames.at(-1)).toMatchObject({
        done: true,
        messageIds: ["m3"]
      });
    });
  });

  it("keeps them after a cutover deletes the stream", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject, ctx) => {
      const stream = createAdapter(instance, ctx.storage.sql);
      const id = stream.start("req-cut", { originMessageIds: ["m4"] });
      stream.storeChunk(id, JSON.stringify({ type: "text-delta", delta: "y" }));
      stream.finish(id);
      stream.cutover(id, () => {});

      expect(
        stream.replayCompletedChunksByRequestId(
          collectingConnection([]),
          "req-cut"
        )
      ).toBe(false);
      expect(stream.getOriginMessageIds("req-cut")).toEqual(["m4"]);
      expect(stream.getOriginMessageIds("req-other")).toBeUndefined();
    });
  });

  it("replays the outcome a stream was closed with", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject, ctx) => {
      const stream = createAdapter(instance, ctx.storage.sql);
      const outcomeOf = (requestId: string) => {
        const frames: Record<string, unknown>[] = [];
        stream.replayCompletedChunksByRequestId(
          collectingConnection(frames),
          requestId
        );
        return frames.at(-1)?.outcome;
      };

      stream.complete(stream.start("req-recovering"), "recovering");
      expect(outcomeOf("req-recovering")).toBe("recovering");

      stream.finish(stream.start("req-aborted"), "aborted");
      stream.finalizePending();
      expect(outcomeOf("req-aborted")).toBe("aborted");

      stream.complete(stream.start("req-completed"));
      expect(outcomeOf("req-completed")).toBeUndefined();

      // The next start reclaims the settled rows; the outcome outlives them.
      stream.start("req-successor");
      expect(stream.getOutcome("req-recovering")).toBe("recovering");
      expect(stream.getOutcome("req-aborted")).toBe("aborted");
      expect(stream.getOutcome("req-completed")).toBeUndefined();
    });
  });

  it("reports an orphaned stream as aborted, not completed", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject, ctx) => {
      const first = createAdapter(instance, ctx.storage.sql);
      const id = first.start("req-orphan-outcome");
      first.storeChunk(id, JSON.stringify({ type: "text-delta", delta: "x" }));
      first.flushBuffer();

      const restored = createAdapter(instance, ctx.storage.sql);
      const live: Record<string, unknown>[] = [];
      restored.replayChunks(collectingConnection(live), "req-orphan-outcome");
      expect(live.at(-1)).toMatchObject({ done: true, outcome: "aborted" });

      const later: Record<string, unknown>[] = [];
      restored.replayCompletedChunksByRequestId(
        collectingConnection(later),
        "req-orphan-outcome"
      );
      expect(later.at(-1)).toMatchObject({ done: true, outcome: "aborted" });
    });
  });

  it("keeps the outcome after a cutover deletes the stream", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject, ctx) => {
      const stream = createAdapter(instance, ctx.storage.sql);
      const id = stream.start("req-cut-aborted");
      stream.finish(id, "aborted");
      stream.cutover(id, () => {});
      expect(stream.getOutcome("req-cut-aborted")).toBe("aborted");
      expect(stream.getOutcome("req-other")).toBeUndefined();
    });
  });

  it("replays a finished stream awaiting its cutover without a terminal", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject, ctx) => {
      const stream = createAdapter(instance, ctx.storage.sql);
      const id = stream.start("req-pending");
      stream.storeChunk(id, JSON.stringify({ type: "text-delta", delta: "z" }));
      stream.finish(id);

      const frames: Record<string, unknown>[] = [];
      stream.replayClosedStreamChunks(
        collectingConnection(frames),
        "req-pending"
      );
      expect(frames.map((frame) => frame.done)).toEqual([false, false]);
      expect(frames.at(-1)).toMatchObject({ replayComplete: true });
    });
  });

  it.each(["recovering", "errored"] as const)(
    "replays a stream closed as %s without a terminal",
    async (close) => {
      const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
      await runInDurableObject(
        stub,
        async (instance: StreamBenchObject, ctx) => {
          const stream = createAdapter(instance, ctx.storage.sql);
          const id = stream.start("req-closed");
          stream.storeChunk(
            id,
            JSON.stringify({ type: "text-delta", delta: "partial" })
          );
          if (close === "recovering") stream.complete(id, "recovering");
          else stream.markError(id);

          const frames: Record<string, unknown>[] = [];
          stream.replayClosedStreamChunks(
            collectingConnection(frames),
            "req-closed"
          );
          expect(frames.map((frame) => frame.done)).toEqual([false, false]);
          expect(JSON.parse(frames[0].body as string)).toMatchObject({
            delta: "partial"
          });
          expect(frames.at(-1)).toMatchObject({ replayComplete: true });
        }
      );
    }
  );

  it("sends only replayComplete once the cutover deleted the rows", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject, ctx) => {
      const stream = createAdapter(instance, ctx.storage.sql);
      const id = stream.start("req-cut-held");
      stream.storeChunk(id, JSON.stringify({ type: "text-delta", delta: "z" }));
      stream.finish(id);
      stream.cutover(id, () => {});

      const frames: Record<string, unknown>[] = [];
      stream.replayClosedStreamChunks(
        collectingConnection(frames),
        "req-cut-held"
      );
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ done: false, replayComplete: true });
    });
  });

  it("omits them for a stream started without ids", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject, ctx) => {
      const stream = createAdapter(instance, ctx.storage.sql);
      const id = stream.start("req-plain");
      stream.complete(id);
      expect(stream.getOriginMessageIds("req-plain")).toBeUndefined();
      const frames: Record<string, unknown>[] = [];
      stream.replayCompletedChunksByRequestId(
        collectingConnection(frames),
        "req-plain"
      );
      expect(frames.at(-1)).not.toHaveProperty("messageIds");
    });
  });
});

describe("ResumableStream parent message id", () => {
  it("keeps a branching stream's parent across a restore", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject, ctx) => {
      const first = createAdapter(instance, ctx.storage.sql);
      const id = first.start("req-branch", { parentMessageId: "u1" });
      first.storeChunk(id, JSON.stringify({ type: "text-delta", delta: "x" }));
      first.flushBuffer();

      const restored = createAdapter(instance, ctx.storage.sql);
      restored.restore();
      expect(restored.activeStreamId).toBe(id);
      expect(restored.getStreamParentMessageId(id)).toBe("u1");
    });
  });

  it("records no parent for a stream that appends to the latest leaf", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject, ctx) => {
      const stream = createAdapter(instance, ctx.storage.sql);
      const id = stream.start("req-leaf");
      expect(stream.getStreamParentMessageId(id)).toBeNull();
      expect(stream.getStreamParentMessageId("missing")).toBeNull();
    });
  });
});
