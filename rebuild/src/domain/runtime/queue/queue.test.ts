import { describe, expect, it, vi } from "vitest";
import { createMemoryKeyValueStore } from "../../../adapters/memory/store.js";
import { createTestClock } from "../../../adapters/memory/clock.js";
import { createEventBus, type ObservabilityEvent } from "../../../kernel/events.js";
import type { IdSource } from "../../../kernel/ids.js";
import { createTaskQueue, type QueueItem } from "./queue.js";

function bus() {
  return createEventBus({ agent: "test", name: "agent-1" }, () => 0);
}

function fakeIds(): IdSource {
  let n = 0;
  return { newId: (prefix: string) => `${prefix}_${++n}` };
}

/** No-op delay so retry backoff doesn't slow down tests. */
const instantDelay = (_ms: number) => Promise.resolve();

describe("createTaskQueue", () => {
  it("processes enqueued tasks in FIFO order", async () => {
    const order: string[] = [];
    const queue = createTaskQueue({
      store: createMemoryKeyValueStore(),
      clock: createTestClock(),
      ids: fakeIds(),
      bus: bus(),
      dispatch: async (callback) => {
        order.push(callback);
      },
    });

    await queue.enqueue("a", { n: 1 });
    await queue.enqueue("b", { n: 2 });
    await queue.enqueue("c", { n: 3 });
    await queue.flush();

    expect(order).toEqual(["a", "b", "c"]);
    expect(queue.size()).toBe(0);
  });

  it("never runs two dispatches concurrently (single-flight)", async () => {
    let active = 0;
    let maxActive = 0;
    const queue = createTaskQueue({
      store: createMemoryKeyValueStore(),
      clock: createTestClock(),
      ids: fakeIds(),
      bus: bus(),
      dispatch: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
      },
    });

    await queue.enqueue("a", {});
    await queue.enqueue("b", {});
    await queue.enqueue("c", {});
    await queue.flush();

    expect(maxActive).toBe(1);
  });

  it("retries a failing task and eventually succeeds", async () => {
    const events: ObservabilityEvent[] = [];
    const b = bus();
    b.subscribe("*", (e) => events.push(e));

    let calls = 0;
    const queue = createTaskQueue({
      store: createMemoryKeyValueStore(),
      clock: createTestClock(),
      ids: fakeIds(),
      bus: b,
      dispatch: async () => {
        calls++;
        if (calls < 3) throw new Error("transient failure");
      },
      retry: { maxAttempts: 5, baseDelayMs: 10 },
      delay: instantDelay,
    });

    const id = await queue.enqueue("flaky", { x: 1 });
    await queue.flush();

    expect(calls).toBe(3);
    expect(queue.get(id)).toBeUndefined();
    const retryEvents = events.filter((e) => e.type === "queue:retry");
    expect(retryEvents).toHaveLength(2);
    expect(retryEvents[0]!.payload.attempts).toBe(1);
    expect(retryEvents[1]!.payload.attempts).toBe(2);
  });

  it("drops the row and emits queue:error after exhausting retries", async () => {
    const events: ObservabilityEvent[] = [];
    const b = bus();
    b.subscribe("*", (e) => events.push(e));

    let calls = 0;
    const queue = createTaskQueue({
      store: createMemoryKeyValueStore(),
      clock: createTestClock(),
      ids: fakeIds(),
      bus: b,
      dispatch: async () => {
        calls++;
        throw new Error("always fails");
      },
      retry: { maxAttempts: 2, baseDelayMs: 10 },
      delay: instantDelay,
    });

    const id = await queue.enqueue("doomed", { x: 1 });
    await queue.flush();

    expect(calls).toBe(2);
    expect(queue.get(id)).toBeUndefined();
    expect(queue.size()).toBe(0);
    const errorEvents = events.filter((e) => e.type === "queue:error");
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]!.payload).toMatchObject({ id, callback: "doomed" });
  });

  it("dequeue removes an item before it executes", async () => {
    // The flush trigger is deferred to a fresh microtask (see queue.ts), so as long as
    // we don't await between enqueue calls, we can dequeue before anything dispatches.
    // ids are deterministic (fakeIds), so we can predict them without awaiting.
    const order: string[] = [];
    const queue = createTaskQueue({
      store: createMemoryKeyValueStore(),
      clock: createTestClock(),
      ids: fakeIds(),
      bus: bus(),
      dispatch: async (callback) => {
        order.push(callback);
      },
    });

    void queue.enqueue("a", {}); // id will be "task_1"
    void queue.enqueue("b", {}); // id will be "task_2"
    queue.dequeue("task_2");
    expect(queue.get("task_2")).toBeUndefined();
    expect(queue.get("task_1")).toBeDefined();

    await queue.flush();

    expect(order).toEqual(["a"]);
  });

  it("dequeueAll clears every pending row", async () => {
    const dispatch = vi.fn(async () => {});
    const queue = createTaskQueue({
      store: createMemoryKeyValueStore(),
      clock: createTestClock(),
      ids: fakeIds(),
      bus: bus(),
      dispatch,
    });

    void queue.enqueue("a", {});
    void queue.enqueue("b", {});
    queue.dequeueAll();
    expect(queue.size()).toBe(0);

    await queue.flush();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dequeueAllByCallback removes only matching rows", async () => {
    const order: string[] = [];
    const queue = createTaskQueue({
      store: createMemoryKeyValueStore(),
      clock: createTestClock(),
      ids: fakeIds(),
      bus: bus(),
      dispatch: async (callback) => {
        order.push(callback);
      },
    });

    void queue.enqueue("keep", {});
    void queue.enqueue("drop", {});
    void queue.enqueue("keep", {});
    queue.dequeueAllByCallback("drop");

    await queue.flush();
    expect(order).toEqual(["keep", "keep"]);
  });

  it("find returns items matching a predicate", async () => {
    const queue = createTaskQueue({
      store: createMemoryKeyValueStore(),
      clock: createTestClock(),
      ids: fakeIds(),
      bus: bus(),
      dispatch: async () => new Promise(() => {}), // never resolves; keep rows pending
    });

    await queue.enqueue("a", { tag: "x" });
    await queue.enqueue("b", { tag: "y" });
    void queue.flush(); // fire and forget; dispatch hangs so rows stay pending except the first in-flight one

    const matches = queue.find((item: QueueItem) => item.callback === "b");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.callback).toBe("b");
  });

  it("resumes pending rows when a new queue is built over the same store", async () => {
    let releaseFirst: () => void = () => {};
    const hang = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const store = createMemoryKeyValueStore();
    const queue1 = createTaskQueue({
      store,
      clock: createTestClock(),
      ids: fakeIds(),
      bus: bus(),
      dispatch: async () => hang, // never resolves during this test
    });

    const id = await queue1.enqueue("resume-me", { a: 1 });
    void queue1.flush(); // starts dispatch, which hangs forever — row stays untouched in storage

    // A second queue instance over the same store should see the still-pending row.
    const queue2Dispatched: unknown[] = [];
    const queue2 = createTaskQueue({
      store,
      clock: createTestClock(),
      ids: fakeIds(),
      bus: bus(),
      dispatch: async (callback, payload) => {
        queue2Dispatched.push({ callback, payload });
      },
    });

    expect(queue2.size()).toBe(1);
    expect(queue2.get(id)).toMatchObject({ callback: "resume-me", payload: { a: 1 } });

    await queue2.flush();
    expect(queue2Dispatched).toEqual([{ callback: "resume-me", payload: { a: 1 } }]);
    expect(queue2.size()).toBe(0);

    releaseFirst();
  });

  it("emits queue:create when a task is enqueued", async () => {
    const events: ObservabilityEvent[] = [];
    const b = bus();
    b.subscribe("*", (e) => events.push(e));
    const queue = createTaskQueue({
      store: createMemoryKeyValueStore(),
      clock: createTestClock(),
      ids: fakeIds(),
      bus: b,
      dispatch: async () => {},
    });

    const id = await queue.enqueue("a", { n: 1 });
    const createEvents = events.filter((e) => e.type === "queue:create");
    expect(createEvents).toHaveLength(1);
    expect(createEvents[0]!.payload).toMatchObject({ id, callback: "a" });
  });
});
