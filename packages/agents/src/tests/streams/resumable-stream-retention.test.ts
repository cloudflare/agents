import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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

describe("ResumableStream terminal retention", () => {
  it("retains cutover evidence across reconstruction and reclaims only after release", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject, ctx) => {
      const construct = () => createAdapter(instance, ctx.storage.sql);
      const stream = construct();
      const id = stream.start("retained-request", {
        messageId: "assistant-message",
        continuation: true
      });
      stream.storeChunk(id, "evidence");
      stream.finish(id);
      stream.cutover(id, () => {}, { retain: true });
      expect(await instance.streams.status(id)).toMatchObject({
        state: "completed",
        metadata: {
          cfChat: 1,
          retained: 1,
          messageId: "assistant-message",
          isContinuation: 1
        }
      });

      const restored = construct();
      restored.start("foreign-request");
      expect(restored.reclaim(Date.now() + 24 * 60 * 60 * 1000)).toBe(0);
      expect(restored.getStreamChunks(id)).toEqual([
        { body: "evidence", chunk_index: 0 }
      ]);
      expect(restored.listRetained()).toEqual([
        { id, requestId: "retained-request" }
      ]);
      restored.release(id);
      restored.release(id);
      expect(restored.listRetained()).toEqual([]);
      expect(restored.getStreamMessageId(id)).toBe("assistant-message");
      expect(restored.reclaim()).toBe(1);
      expect(restored.getStreamMetadata(id)).toBeNull();
      restored.release(id);
    });
  });

  it.each(["error", "empty-completion"] as const)(
    "retains %s terminal evidence until release",
    async (outcome) => {
      const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
      await runInDurableObject(
        stub,
        async (instance: StreamBenchObject, ctx) => {
          const stream = createAdapter(instance, ctx.storage.sql);
          const id = stream.start("terminal-request");
          if (outcome === "error") {
            stream.markError(id, { retain: true });
          } else {
            stream.finish(id);
            stream.finalizePending({ retain: true });
          }
          stream.start("foreign-request");
          expect(stream.getStreamMetadata(id)?.status).toBe(
            outcome === "error" ? "error" : "completed"
          );
          expect(stream.listRetained()).toEqual([
            { id, requestId: "terminal-request" }
          ]);
          stream.release(id);
          expect(stream.reclaim()).toBe(1);
        }
      );
    }
  );

  it("keeps discard:false child rows reclaimable and rolls back retention with cutover", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject, ctx) => {
      const stream = createAdapter(instance, ctx.storage.sql);
      const child = stream.start("child-request");
      stream.cutover(child, () => {}, { discard: false });
      expect(stream.listRetained()).toEqual([]);
      expect(stream.reclaim()).toBe(1);
      const id = stream.start("rollback-request");
      stream.finish(id);
      expect(() =>
        stream.cutover(
          id,
          () => {
            throw new Error("persist failed");
          },
          { retain: true }
        )
      ).toThrow("persist failed");
      expect(stream.getStreamMetadata(id)?.status).toBe("streaming");
      expect(stream.listRetained()).toEqual([]);
      stream.cutover(id, () => {}, { retain: true });
      expect(stream.reclaim()).toBe(0);
      stream.release(id);
      expect(stream.reclaim()).toBe(1);
    });
  });
});
