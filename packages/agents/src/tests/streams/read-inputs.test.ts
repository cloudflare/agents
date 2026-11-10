import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { StreamHarnessObject } from "../capabilities/streams";

describe("streams contract gaps", () => {
  it("list() breaks created_at ties by insertion order", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      await instance.lifecycle.start();
      const sync = instance.streams.__DO_NOT_USE_WILL_BREAK__sync();
      const at = Date.now();
      for (const streamId of ["tie-c", "tie-a", "tie-b"]) {
        sync.importStream({
          streamId,
          state: "streaming",
          tag: "tie",
          metadata: undefined,
          chunkCount: 0,
          createdAt: at,
          updatedAt: at,
          closedAt: null
        });
      }
      const listed = await instance.streams.list({ tag: "tie" });
      expect(listed.map((s) => s.streamId)).toEqual([
        "tie-b",
        "tie-a",
        "tie-c"
      ]);
    });
  });

  it("rejects an async commit and rolls back", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      await instance.lifecycle.start();
      const stream = await instance.streams.open("s1");
      expect(() =>
        stream.close({
          commit: (async () => {
            await Promise.resolve();
            throw new Error("late");
          }) as unknown as () => void,
          discard: true
        })
      ).toThrow(TypeError);
      expect((await instance.streams.status("s1"))?.state).toBe("streaming");
    });
  });

  it("rejects an async commit before it runs", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      await instance.lifecycle.start();
      const stream = await instance.streams.open("s3");
      let started = false;
      let continued = false;
      expect(() =>
        stream.close({
          commit: (async () => {
            started = true;
            await Promise.resolve();
            continued = true;
          }) as unknown as () => void,
          discard: true
        })
      ).toThrow(TypeError);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(started).toBe(false);
      expect(continued).toBe(false);
      expect((await instance.streams.status("s3"))?.state).toBe("streaming");
    });
  });

  it("rejects a promise-returning commit and rolls back", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      await instance.lifecycle.start();
      const stream = await instance.streams.open("s4");
      expect(() =>
        stream.close({
          commit: (() =>
            Promise.reject(new Error("late"))) as unknown as () => void,
          discard: true
        })
      ).toThrow(TypeError);
      expect((await instance.streams.status("s4"))?.state).toBe("streaming");
    });
  });

  it("validates from and batchSize", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      await instance.lifecycle.start();
      const stream = await instance.streams.open("s2");
      stream.append({ type: "text-delta", delta: "a" });
      await expect(
        instance.streams.read("s2", { from: 1.5 }).next()
      ).rejects.toThrow(RangeError);
      await expect(
        instance.streams.readBatches("s2", { batchSize: NaN }).next()
      ).rejects.toThrow(RangeError);
    });
  });
});
