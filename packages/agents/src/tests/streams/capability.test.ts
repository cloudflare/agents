import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  StreamHarnessObject,
  TaskStreamComposeObject
} from "../capabilities/streams";
import { seedTaskRun, seedTaskStep } from "../capabilities/tasks";
import { captureDiagnosticsEvents } from "../shared/diagnostics-capture";
import type { StreamChunk } from "../../streams";

/**
 * Capability-level Streams tests: the capability installed on a minimal real
 * Durable Object through a real Lifecycle over real SQLite — no fakes.
 * `StreamHarnessObject` proves the primitive stands alone (no alarm, no
 * other capability); `TaskStreamComposeObject` proves the Tasks composition
 * contract, including recovery from stream evidence after a fabricated
 * interruption.
 */

async function collect(
  iterator: AsyncGenerator<StreamChunk, void, undefined>
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterator) chunks.push(chunk);
  return chunks;
}

describe("Streams capability", () => {
  it("appends durable chunks with a monotonic cursor and settles", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      const stream = await instance.streams.open("s1", {
        metadata: { topic: "demo" }
      });
      expect(stream.cursor).toBe(0);
      expect(stream.append({ n: 0 })).toBe(0);
      expect(stream.append({ n: 1 })).toBe(1);
      expect(stream.cursor).toBe(2);

      const live = await instance.streams.status("s1");
      expect(live).toMatchObject({
        streamId: "s1",
        state: "streaming",
        cursor: 2,
        metadata: { topic: "demo" }
      });

      stream.close();
      const settled = await instance.streams.status("s1");
      expect(settled?.state).toBe("completed");
      expect(settled?.cursor).toBe(2);
      expect(settled?.closedAt).toBeGreaterThan(0);
    });
  });

  it("replays a settled stream from any cursor and ends", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      const stream = await instance.streams.open("replay");
      for (let i = 0; i < 5; i++) stream.append({ i });
      stream.close();

      const all = await collect(instance.streams.read("replay"));
      expect(all.map((c) => c.seq)).toEqual([0, 1, 2, 3, 4]);
      expect(all[3].chunk).toEqual({ i: 3 });

      const fromTwo = await collect(
        instance.streams.read("replay", { from: 2 })
      );
      expect(fromTwo.map((c) => c.seq)).toEqual([2, 3, 4]);
    });
  });

  it("readBatches slices replay by batchSize from a cursor", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      const stream = await instance.streams.open("batched");
      for (let i = 0; i < 5; i++) stream.append({ i });
      stream.close();

      const batches: number[][] = [];
      for await (const batch of instance.streams.readBatches("batched", {
        batchSize: 2
      })) {
        batches.push(batch.map((c) => c.seq));
      }
      expect(batches).toEqual([[0, 1], [2, 3], [4]]);

      const fromOne: number[][] = [];
      for await (const batch of instance.streams.readBatches("batched", {
        from: 1,
        batchSize: 2
      })) {
        fromOne.push(batch.map((c) => c.seq));
      }
      expect(fromOne).toEqual([
        [1, 2],
        [3, 4]
      ]);
    });
  });

  it("readBatches coalesces a live tail into one batch per wakeup", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      const stream = await instance.streams.open("coalesce");
      stream.append({ i: 0 });

      const batches: number[][] = [];
      const reading = (async () => {
        for await (const batch of instance.streams.readBatches("coalesce")) {
          batches.push(batch.map((c) => c.seq));
        }
      })();

      await new Promise((resolve) => setTimeout(resolve, 5));
      // Three appends and the close land in one synchronous block, so the
      // tailing reader wakes once and drains the backlog as one array.
      stream.append({ i: 1 });
      stream.append({ i: 2 });
      stream.append({ i: 3 });
      stream.close();

      await reading;
      expect(batches).toEqual([[0], [1, 2, 3]]);
    });
  });

  it("tails a live stream and ends when the producer settles", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      const stream = await instance.streams.open("tail");
      stream.append({ i: 0 });

      // The reader starts mid-stream: it replays chunk 0, then tails.
      const reading = collect(instance.streams.read("tail"));

      await new Promise((resolve) => setTimeout(resolve, 5));
      stream.append({ i: 1 });
      await new Promise((resolve) => setTimeout(resolve, 5));
      stream.append({ i: 2 });
      stream.close();

      const chunks = await reading;
      expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2]);
    });
  });

  it("reopens a live stream at its cursor and rejects terminal reopens", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      const first = await instance.streams.open("reopen");
      first.append("a");
      first.append("b");

      const second = await instance.streams.open("reopen");
      expect(second.cursor).toBe(2);
      expect(second.append("c")).toBe(2);

      second.close();
      await expect(instance.streams.open("reopen")).rejects.toThrow(
        /already settled as completed/
      );
      // A stale writer cannot append past settlement either.
      expect(() => first.append("d")).toThrow(/already settled/);
      // Settling again is an idempotent no-op for recovery callers.
      first.close();
      first.error("late");
      expect((await instance.streams.status("reopen"))?.state).toBe(
        "completed"
      );
    });
  });

  it("records error settlement and still serves the chunk log", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      const stream = await instance.streams.open("broken");
      stream.append({ i: 0 });
      stream.error("provider disconnected");

      const status = await instance.streams.status("broken");
      expect(status).toMatchObject({
        state: "errored",
        error: "provider disconnected",
        cursor: 1
      });

      const chunks = await collect(instance.streams.read("broken"));
      expect(chunks.map((c) => c.seq)).toEqual([0]);
    });
  });

  it("throws for missing streams on read and probes null on status", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      expect(await instance.streams.status("ghost")).toBeNull();
      await expect(collect(instance.streams.read("ghost"))).rejects.toThrow(
        /does not exist/
      );
    });
  });

  it("aborts a tailing read with the signal reason", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      await instance.streams.open("hanging");
      const controller = new AbortController();
      const reading = collect(
        instance.streams.read("hanging", { signal: controller.signal })
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort(new Error("viewer left"));
      await expect(reading).rejects.toThrow("viewer left");
    });
  });

  it("enforces the chunk size limit", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      const stream = await instance.streams.open("bounded");
      // The harness capability caps chunks at 1024 bytes.
      expect(() => stream.append("x".repeat(2000))).toThrow(
        /exceeds the 1024-byte limit/
      );
      expect(stream.append("small")).toBe(0);
    });
  });

  it("deletes only terminal streams", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      const stream = await instance.streams.open("finished");
      stream.append({ i: 0 });
      await expect(instance.streams.delete("finished")).rejects.toThrow(
        /live stream/
      );
      stream.close();
      expect(await instance.streams.delete("finished")).toBe(true);
      expect(await instance.streams.status("finished")).toBeNull();
      expect(await instance.streams.delete("finished")).toBe(false);
    });
  });

  it("lists streams filtered by state", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      (await instance.streams.open("list-live")).append("x");
      const done = await instance.streams.open("list-done");
      done.close();

      const streaming = await instance.streams.list({ state: "streaming" });
      expect(streaming.map((s) => s.streamId)).toEqual(["list-live"]);
      const all = await instance.streams.list();
      expect(all.map((s) => s.streamId).sort()).toEqual([
        "list-done",
        "list-live"
      ]);
    });
  });

  it("emits lifecycle capability events", async () => {
    const name = crypto.randomUUID();
    const stub = env.StreamHarnessObject.getByName(name);
    const capture = captureDiagnosticsEvents("agents:stream", name);
    try {
      await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
        const stream = await instance.streams.open("observed");
        stream.append({ i: 0 });
        stream.close();
        await instance.streams.delete("observed");
      });
      expect(capture.events.map((event) => event.type)).toEqual([
        "stream:opened",
        "stream:closed",
        "stream:deleted"
      ]);
    } finally {
      capture.stop();
    }
  });
});

describe("Streams composed with Tasks", () => {
  it("streams a task to completion with checkpointed cursors", async () => {
    const stub = env.TaskStreamComposeObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskStreamComposeObject) => {
        const receipt = await instance.tasks.run("generate", {
          streamId: "gen-1",
          total: 4
        });

        const deadline = Date.now() + 5_000;
        for (;;) {
          const snapshot = await instance.tasks.get(receipt.runId);
          if (snapshot?.state === "completed") break;
          if (Date.now() > deadline) throw new Error("task never completed");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }

        const status = await instance.streams.status("gen-1");
        expect(status).toMatchObject({ state: "completed", cursor: 4 });
        const chunks = await collect(instance.streams.read("gen-1"));
        expect(chunks.map((c) => c.chunk)).toEqual([
          { i: 0 },
          { i: 1 },
          { i: 2 },
          { i: 3 }
        ]);
        expect(instance.produced).toHaveLength(4);
      }
    );
  });

  it("recover reads stream evidence and finalizes from the cursor", async () => {
    const stub = env.TaskStreamComposeObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskStreamComposeObject, state) => {
        await instance.lifecycle.start();
        // A real stream with two durably appended chunks whose producer
        // "died": the task run is seeded as claimed by a dead generation,
        // with the step checkpoint carrying the stream cursor.
        const stream = await instance.streams.open("gen-lost");
        stream.append({ i: 0 });
        stream.append({ i: 1 });

        seedTaskRun(state.storage, {
          runId: "lost-producer",
          definition: "generate",
          input: { streamId: "gen-lost", total: 5 },
          state: "running",
          generation: "dead-generation",
          attempt: 1,
          nextAt: Date.now() - 1000
        });
        seedTaskStep(state.storage, {
          runId: "lost-producer",
          name: "stream",
          kind: "do",
          state: "running",
          attempt: 1,
          checkpoint: { streamId: "gen-lost", cursor: 2 }
        });
        await instance.lifecycle.rearmAlarm();
      }
    );

    await runDurableObjectAlarm(stub);

    await runInDurableObject(
      stub,
      async (instance: TaskStreamComposeObject) => {
        const deadline = Date.now() + 5_000;
        for (;;) {
          const snapshot = await instance.tasks.get("lost-producer");
          if (snapshot?.state === "completed") {
            expect(snapshot.result).toEqual({
              streamId: "gen-lost",
              cursor: 2
            });
            break;
          }
          if (Date.now() > deadline) throw new Error("recovery never settled");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }

        // The recovery decision finalized the stream from durable evidence;
        // no producer code re-ran.
        expect(instance.produced).toEqual([]);
        expect(instance.recoveryEvidence).toEqual([
          {
            step: "stream",
            streamState: "streaming",
            streamCursor: 2,
            checkpointCursor: 2
          }
        ]);
        const status = await instance.streams.status("gen-lost");
        expect(status).toMatchObject({ state: "completed", cursor: 2 });
      }
    );
  });
});
