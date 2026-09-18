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
