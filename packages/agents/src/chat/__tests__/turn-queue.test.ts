import { describe, it, expect } from "vitest";
import { TurnQueue } from "../turn-queue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("TurnQueue", () => {
  // ── Serialization ────────────────────────────────────────────────

  it("serializes enqueued work so the second waits for the first", async () => {
    const queue = new TurnQueue();
    const order: number[] = [];
    const gate = deferred();

    const first = queue.enqueue("r1", async () => {
      order.push(1);
      await gate.promise;
      order.push(2);
    });

    const second = queue.enqueue("r2", async () => {
      order.push(3);
    });

    // Only the first turn should have started
    await Promise.resolve();
    expect(order).toEqual([1]);

    gate.resolve();
    await first;
    await second;
    expect(order).toEqual([1, 2, 3]);
  });

  // ── Return value ─────────────────────────────────────────────────

  it("returns the fn's value in a completed result", async () => {
    const queue = new TurnQueue();
    const result = await queue.enqueue("r1", async () => 42);
    expect(result).toEqual({ status: "completed", value: 42 });
  });

  // ── Generation skip ──────────────────────────────────────────────

  it("auto-skips stale turns without calling fn", async () => {
    const queue = new TurnQueue();
    const gate = deferred();
    let secondCalled = false;

    const first = queue.enqueue("r1", async () => {
      await gate.promise;
    });

    const second = queue.enqueue("r2", async () => {
      secondCalled = true;
    });

    queue.reset();
    gate.resolve();

    await first;
    const result = await second;

    expect(secondCalled).toBe(false);
    expect(result).toEqual({ status: "stale" });
  });

  // ── waitForIdle ──────────────────────────────────────────────────

  it("resolves when the queue is fully drained", async () => {
    const queue = new TurnQueue();
    const gate = deferred();
    let done = false;

    queue.enqueue("r1", async () => {
      await gate.promise;
    });

    const idle = queue.waitForIdle().then(() => {
      done = true;
    });

    await Promise.resolve();
    expect(done).toBe(false);

    gate.resolve();
    await idle;
    expect(done).toBe(true);
  });

  it("handles new enqueues during execution", async () => {
    const queue = new TurnQueue();
    const order: string[] = [];

    await queue.enqueue("r1", async () => {
      order.push("r1-start");
      // Enqueue more work from inside a turn
      queue.enqueue("r2", async () => {
        order.push("r2");
      });
      order.push("r1-end");
    });

    await queue.waitForIdle();
    expect(order).toEqual(["r1-start", "r1-end", "r2"]);
  });

  // ── queuedCount ──────────────────────────────────────────────────

  it("tracks per-generation counts accurately", async () => {
    const queue = new TurnQueue();
    const gate = deferred();

    expect(queue.queuedCount()).toBe(0);

    queue.enqueue("r1", async () => {
      await gate.promise;
    });
    expect(queue.queuedCount()).toBe(1);

    queue.enqueue("r2", async () => {});
    expect(queue.queuedCount()).toBe(2);

    gate.resolve();
    await queue.waitForIdle();
    expect(queue.queuedCount()).toBe(0);
  });

  // ── activeRequestId ──────────────────────────────────────────────

  it("tracks active request during execution", async () => {
    const queue = new TurnQueue();

    expect(queue.activeRequestId).toBeNull();
    expect(queue.isActive).toBe(false);

    let capturedId: string | null = null;
    let capturedIsActive = false;

    await queue.enqueue("r1", async () => {
      capturedId = queue.activeRequestId;
      capturedIsActive = queue.isActive;
    });

    expect(capturedId).toBe("r1");
    expect(capturedIsActive).toBe(true);
    expect(queue.activeRequestId).toBeNull();
    expect(queue.isActive).toBe(false);
  });

  // ── Error propagation ────────────────────────────────────────────

  it("propagates fn errors but keeps the queue running", async () => {
    const queue = new TurnQueue();

    const first = queue
      .enqueue("r1", async () => {
        throw new Error("boom");
      })
      .catch((e: Error) => e.message);

    const second = queue.enqueue("r2", async () => "ok");

    expect(await first).toBe("boom");
    expect(await second).toEqual({ status: "completed", value: "ok" });
    expect(queue.isActive).toBe(false);
  });

  // ── Multiple resets ──────────────────────────────────────────────

  it("advances generation on each reset", async () => {
    const queue = new TurnQueue();
    expect(queue.generation).toBe(0);

    queue.reset();
    expect(queue.generation).toBe(1);

    queue.reset();
    expect(queue.generation).toBe(2);
  });

  it("skips turns from multiple stale generations", async () => {
    const queue = new TurnQueue();
    const gate = deferred();
    const called: string[] = [];

    const first = queue.enqueue("r1", async () => {
      await gate.promise;
      called.push("r1");
    });

    // Let r1 start executing (it awaits the gate inside fn)
    await Promise.resolve();

    const second = queue.enqueue("r2", async () => {
      called.push("r2");
    });

    queue.reset();

    const third = queue.enqueue("r3", async () => {
      called.push("r3");
    });

    queue.reset();

    gate.resolve();
    await first;
    const r2 = await second;
    const r3 = await third;

    expect(called).toEqual(["r1"]);
    expect(r2).toEqual({ status: "stale" });
    expect(r3).toEqual({ status: "stale" });
  });

  // ── Concurrent enqueues ──────────────────────────────────────────

  it("serializes N items in FIFO order", async () => {
    const queue = new TurnQueue();
    const order: number[] = [];

    const promises = Array.from({ length: 5 }, (_, i) =>
      queue.enqueue(`r${i}`, async () => {
        order.push(i);
        return i;
      })
    );

    const results = await Promise.all(promises);
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(results).toEqual(
      [0, 1, 2, 3, 4].map((v) => ({ status: "completed", value: v }))
    );
  });

  // ── Explicit generation option ───────────────────────────────────

  it("respects explicit generation option for stale detection", async () => {
    const queue = new TurnQueue();
    const gen0 = queue.generation;

    queue.reset();

    let called = false;
    const result = await queue.enqueue(
      "r1",
      async () => {
        called = true;
      },
      { generation: gen0 }
    );

    expect(called).toBe(false);
    expect(result).toEqual({ status: "stale" });
  });

  it("runs fn when explicit generation matches current", async () => {
    const queue = new TurnQueue();
    queue.reset();
    const gen1 = queue.generation;

    const result = await queue.enqueue("r1", async () => "hello", {
      generation: gen1
    });

    expect(result).toEqual({ status: "completed", value: "hello" });
  });

  // ── queuedCount with stale generations ───────────────────────────

  it("decrements count for stale turns that get skipped", async () => {
    const queue = new TurnQueue();
    const gate = deferred();

    queue.enqueue("r1", async () => {
      await gate.promise;
    });

    const gen0 = queue.generation;
    queue.enqueue("r2", async () => {});
    expect(queue.queuedCount(gen0)).toBe(2);

    queue.reset();
    gate.resolve();
    await queue.waitForIdle();

    expect(queue.queuedCount(gen0)).toBe(0);
  });

  // ── reset during active execution ────────────────────────────────

  it("completes the active fn after reset but skips queued turns", async () => {
    const queue = new TurnQueue();
    const gate = deferred();
    const events: string[] = [];

    const first = queue.enqueue("r1", async () => {
      events.push("r1-start");
      await gate.promise;
      events.push("r1-end");
      return "r1-value";
    });

    // Let r1 start
    await Promise.resolve();

    const second = queue.enqueue("r2", async () => {
      events.push("r2");
      return "r2-value";
    });

    queue.reset();
    gate.resolve();

    const r1 = await first;
    const r2 = await second;

    expect(events).toEqual(["r1-start", "r1-end"]);
    expect(r1).toEqual({ status: "completed", value: "r1-value" });
    expect(r2).toEqual({ status: "stale" });
  });

  // ── waitForIdle on an idle queue ─────────────────────────────────

  it("resolves immediately when the queue is already idle", async () => {
    const queue = new TurnQueue();
    await queue.waitForIdle();
  });

  it("resolves immediately after all work has drained", async () => {
    const queue = new TurnQueue();
    await queue.enqueue("r1", async () => {});
    await queue.waitForIdle();
  });
});
