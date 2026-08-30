import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  StreamHarnessObject,
  TaskStreamComposeObject
} from "../capabilities/streams";
import { seedTaskRun, seedTaskStep } from "../capabilities/tasks";
import { captureDiagnosticsEvents } from "../shared/diagnostics-capture";
import { sseResponse, type StreamChunk } from "../../streams";

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

  it("tags streams at open and finds them via list", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      const first = await instance.streams.open("t1", { tag: "req-9" });
      first.close();
      (await instance.streams.open("t2", { tag: "req-9" })).append({ i: 0 });
      await instance.streams.open("t3", { tag: "req-other" });
      await instance.streams.open("untagged");

      expect((await instance.streams.status("t2"))?.tag).toBe("req-9");
      expect((await instance.streams.status("untagged"))?.tag).toBeUndefined();

      // Non-unique by design: successive streams of one operation share the
      // tag, newest first — and the filter composes with state.
      const tagged = await instance.streams.list({ tag: "req-9" });
      expect(tagged.map((s) => s.streamId)).toEqual(["t2", "t1"]);
      const live = await instance.streams.list({
        tag: "req-9",
        state: "streaming"
      });
      expect(live.map((s) => s.streamId)).toEqual(["t2"]);

      // The tag is part of the stream's identity: reopening with the same
      // (or no) tag resumes, a different tag is a config conflict.
      await instance.streams.open("t2", { tag: "req-9" });
      await instance.streams.open("t2");
      await expect(
        instance.streams.open("t2", { tag: "req-else" })
      ).rejects.toThrow(/refusing reopen/);
    });
  });

  it("signals up-to-date once when a reader reaches the tail", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      const stream = await instance.streams.open("utd");
      stream.append({ i: 0 });
      stream.append({ i: 1 });

      const order: string[] = [];
      const reading = (async () => {
        for await (const batch of instance.streams.readBatches("utd", {
          batchSize: 1,
          onUpToDate: () => order.push("up-to-date")
        })) {
          order.push(`batch:${batch.map((c) => c.seq).join(",")}`);
        }
      })();

      await new Promise((resolve) => setTimeout(resolve, 5));
      stream.append({ i: 2 });
      stream.close();
      await reading;

      // Fires after the stored backlog drained, before live-tail chunks —
      // and only once, even though the tail catches up again later.
      expect(order).toEqual(["batch:0", "batch:1", "up-to-date", "batch:2"]);
    });
  });

  it("a synchronous append inside onUpToDate is not a lost wakeup", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      const stream = await instance.streams.open("utd-append");
      stream.append({ i: 0 });

      const order: string[] = [];
      const reading = (async () => {
        for await (const batch of instance.streams.readBatches("utd-append", {
          onUpToDate: () => {
            order.push("up-to-date");
            // Application code appending from the caught-up callback:
            // its wake fires before any waiter registers, so only a
            // re-poll can observe this chunk without a later append.
            stream.append({ i: 1 });
          }
        })) {
          order.push(`batch:${batch.map((c) => c.seq).join(",")}`);
        }
      })();

      // The callback's chunk must arrive with NO further append or close.
      const deadline = Date.now() + 2_000;
      while (!order.includes("batch:1") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(order).toContain("batch:1");

      stream.close();
      await reading;
      expect(order).toEqual(["batch:0", "up-to-date", "batch:1"]);
    });
  });

  it("serves a stream over SSE with Last-Event-ID resume and terminal events", async () => {
    const stub = env.StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamHarnessObject) => {
      const stream = await instance.streams.open("sse");
      for (let i = 0; i < 4; i++) stream.append({ i });
      stream.close();

      const readAll = async (response: Response): Promise<string> => {
        expect(response.headers.get("content-type")).toContain(
          "text/event-stream"
        );
        return new Response(response.body).text();
      };

      const full = await readAll(
        await sseResponse(instance.streams, "sse", { heartbeatMs: 0 })
      );
      expect(full).toContain('id: 0\ndata: {"i":0}');
      expect(full).toContain('id: 3\ndata: {"i":3}');
      // Control events: caught-up marker before the terminal `done`.
      expect(full.indexOf("event: up-to-date")).toBeGreaterThan(-1);
      expect(full.indexOf("event: done")).toBeGreaterThan(
        full.indexOf("id: 3")
      );

      // A reconnecting EventSource sends Last-Event-ID = last received id;
      // the helper resumes from the next chunk.
      const resumed = await readAll(
        await sseResponse(instance.streams, "sse", {
          heartbeatMs: 0,
          request: new Request("https://example.com/sse", {
            headers: { "Last-Event-ID": "2" }
          })
        })
      );
      expect(resumed).not.toContain("id: 2\n");
      expect(resumed).toContain('id: 3\ndata: {"i":3}');

      // A fresh EventSource connection sends no Last-Event-ID header at all;
      // the documented `{ request }` form must start at chunk 0.
      const fresh = await readAll(
        await sseResponse(instance.streams, "sse", {
          heartbeatMs: 0,
          request: new Request("https://example.com/sse")
        })
      );
      expect(fresh).toContain('id: 0\ndata: {"i":0}');

      // Without the header, `?from=` picks the start; garbage falls back to 0.
      const fromParam = await readAll(
        await sseResponse(instance.streams, "sse", {
          heartbeatMs: 0,
          request: new Request("https://example.com/sse?from=2")
        })
      );
      expect(fromParam).not.toContain("id: 1\n");
      expect(fromParam).toContain('id: 2\ndata: {"i":2}');
      const garbage = await readAll(
        await sseResponse(instance.streams, "sse", {
          heartbeatMs: 0,
          request: new Request("https://example.com/sse?from=abc")
        })
      );
      expect(garbage).toContain('id: 0\ndata: {"i":0}');

      // A pre-aborted signal ends the response instead of tailing the live
      // stream forever — listeners added to aborted signals never fire, so
      // completion of this read IS the assertion.
      const live = await instance.streams.open("sse-live");
      live.append({ i: 0 });
      await readAll(
        await sseResponse(instance.streams, "sse-live", {
          heartbeatMs: 0,
          signal: AbortSignal.abort()
        })
      );
      live.close();

      const broken = await instance.streams.open("sse-broken");
      broken.append({ i: 0 });
      broken.error("provider hung up");
      const errored = await readAll(
        await sseResponse(instance.streams, "sse-broken", { heartbeatMs: 0 })
      );
      expect(errored).toContain(
        'event: error\ndata: {"reason":"provider hung up"}'
      );

      const missing = await sseResponse(instance.streams, "ghost", {
        heartbeatMs: 0
      });
      expect(missing.status).toBe(404);
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

  it("replay resumes the producer from the stream's durable cursor", async () => {
    const stub = env.TaskStreamComposeObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskStreamComposeObject, state) => {
        await instance.lifecycle.start();
        // A real stream with two durably appended chunks whose producer
        // "died": the task run is seeded as claimed by a dead generation
        // with its producing step mid-execution.
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
          attempt: 1
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
              cursor: 5
            });
            break;
          }
          if (Date.now() > deadline) throw new Error("replay never settled");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }

        // The replayed producer read the stream's durable cursor as its
        // recovery evidence and resumed exactly there — the two chunks that
        // survived the interruption were never produced again.
        expect(instance.entryCursors).toEqual([
          { streamId: "gen-lost", cursor: 2 }
        ]);
        expect(instance.produced).toEqual([
          "gen-lost:2",
          "gen-lost:3",
          "gen-lost:4"
        ]);
        const status = await instance.streams.status("gen-lost");
        expect(status).toMatchObject({ state: "completed", cursor: 5 });
        const chunks: number[] = [];
        for await (const chunk of instance.streams.read("gen-lost")) {
          chunks.push(chunk.seq);
        }
        expect(chunks).toEqual([0, 1, 2, 3, 4]);
      }
    );
  });
});
