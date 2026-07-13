import { describe, expect, it } from "vitest";
import { createTurnQueue } from "./admission.js";

/** A promise plus externally-callable resolve/reject, for controlling interleaving in tests. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createTurnQueue", () => {
  it("serializes tasks in FIFO order, never interleaving", async () => {
    const queue = createTurnQueue();
    const events: string[] = [];

    const first = deferred<void>();
    const p1 = queue.run({
      requestId: "r1",
      trigger: "chat",
      execute: async () => {
        events.push("r1:start");
        await first.promise;
        events.push("r1:end");
      },
    });

    // r2 is enqueued while r1 is running; it must not start until r1 finishes.
    const p2 = queue.run({
      requestId: "r2",
      trigger: "chat",
      execute: async () => {
        events.push("r2:start");
        events.push("r2:end");
      },
    });

    // Give the microtask queue a chance to (wrongly) start r2 early.
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["r1:start"]);

    first.resolve();
    await p1;
    await p2;

    expect(events).toEqual(["r1:start", "r1:end", "r2:start", "r2:end"]);
  });

  it("reports the running task and pending count", async () => {
    const queue = createTurnQueue();
    const gate = deferred<void>();

    const p1 = queue.run({
      requestId: "r1",
      trigger: "chat",
      execute: async () => {
        await gate.promise;
      },
    });
    const p2 = queue.run({
      requestId: "r2",
      trigger: "chat",
      execute: async () => {},
    });

    await Promise.resolve();
    expect(queue.running()).toEqual({ requestId: "r1", trigger: "chat" });
    expect(queue.pending()).toBe(1);

    gate.resolve();
    await p1;
    await p2;

    expect(queue.running()).toBeNull();
    expect(queue.pending()).toBe(0);
  });

  it("replace admission aborts the running turn then runs", async () => {
    const queue = createTurnQueue();
    const events: string[] = [];
    let sawAbort = false;

    const p1 = queue.run({
      requestId: "r1",
      trigger: "chat",
      execute: (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            sawAbort = true;
            events.push("r1:aborted");
            resolve();
          });
        }),
    });

    await Promise.resolve();
    expect(queue.running()?.requestId).toBe("r1");

    const p2 = queue.run({
      requestId: "r2",
      trigger: "chat",
      admission: "replace",
      execute: async () => {
        events.push("r2:ran");
      },
    });

    await p1;
    await p2;

    expect(sawAbort).toBe(true);
    expect(events).toEqual(["r1:aborted", "r2:ran"]);
  });

  it("replace jumps ahead of already-queued tasks", async () => {
    const queue = createTurnQueue();
    const events: string[] = [];
    const gate = deferred<void>();

    const p1 = queue.run({
      requestId: "r1",
      trigger: "chat",
      execute: async () => {
        await gate.promise;
      },
    });
    const p2 = queue.run({
      requestId: "r2",
      trigger: "chat",
      execute: async () => {
        events.push("r2");
      },
    });
    const p3 = queue.run({
      requestId: "r3",
      trigger: "chat",
      admission: "replace",
      execute: async () => {
        events.push("r3");
      },
    });

    gate.resolve();
    await Promise.all([p1, p2, p3]);

    expect(events).toEqual(["r3", "r2"]);
  });

  it("reject admission fails fast when busy", async () => {
    const queue = createTurnQueue();
    const gate = deferred<void>();

    const p1 = queue.run({
      requestId: "r1",
      trigger: "chat",
      execute: async () => {
        await gate.promise;
      },
    });

    await Promise.resolve();
    await expect(
      queue.run({
        requestId: "r2",
        trigger: "chat",
        admission: "reject",
        execute: async () => {},
      })
    ).rejects.toThrow();

    gate.resolve();
    await p1;
  });

  it("reject admission runs immediately when idle", async () => {
    const queue = createTurnQueue();
    const result = await queue.run({
      requestId: "r1",
      trigger: "chat",
      admission: "reject",
      execute: async () => "ok",
    });
    expect(result).toBe("ok");
  });

  it("cancel(requestId) aborts the running task", async () => {
    const queue = createTurnQueue();
    let aborted = false;

    const p1 = queue.run({
      requestId: "r1",
      trigger: "chat",
      execute: (signal) =>
        new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    });

    await Promise.resolve();
    expect(queue.cancel("r1")).toBe(true);
    await expect(p1).rejects.toThrow();
    expect(aborted).toBe(true);
  });

  it("cancel(requestId) removes a pending (not-yet-running) task", async () => {
    const queue = createTurnQueue();
    const gate = deferred<void>();

    const p1 = queue.run({
      requestId: "r1",
      trigger: "chat",
      execute: async () => {
        await gate.promise;
      },
    });
    const p2 = queue.run({
      requestId: "r2",
      trigger: "chat",
      execute: async () => "should not run",
    });

    await Promise.resolve();
    expect(queue.cancel("r2")).toBe(true);
    expect(queue.pending()).toBe(0);

    gate.resolve();
    await p1;
    await expect(p2).rejects.toThrow();
  });

  it("cancel returns false for an unknown requestId", () => {
    const queue = createTurnQueue();
    expect(queue.cancel("nope")).toBe(false);
  });

  it("cancelAll aborts the running task and drops all pending tasks", async () => {
    const queue = createTurnQueue();
    const gate = deferred<void>();

    const p1 = queue.run({
      requestId: "r1",
      trigger: "chat",
      execute: (signal) =>
        new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted r1")));
        }),
    });
    const p2 = queue.run({
      requestId: "r2",
      trigger: "chat",
      execute: async () => "unreachable",
    });

    await Promise.resolve();
    queue.cancelAll("shutdown");

    await expect(p1).rejects.toThrow();
    await expect(p2).rejects.toThrow();
    expect(queue.pending()).toBe(0);
    gate.resolve();
  });

  it("waitUntilStable resolves immediately when idle", async () => {
    const queue = createTurnQueue();
    await expect(queue.waitUntilStable()).resolves.toBeUndefined();
  });

  it("waitUntilStable resolves only once running + pending are empty", async () => {
    const queue = createTurnQueue();
    const gate = deferred<void>();
    let stableResolved = false;

    const p1 = queue.run({
      requestId: "r1",
      trigger: "chat",
      execute: async () => {
        await gate.promise;
      },
    });
    queue.run({
      requestId: "r2",
      trigger: "chat",
      execute: async () => {},
    });

    const stable = queue.waitUntilStable().then(() => {
      stableResolved = true;
    });

    await Promise.resolve();
    expect(stableResolved).toBe(false);

    gate.resolve();
    await p1;
    await stable;
    expect(stableResolved).toBe(true);
  });

  it("does not deadlock when a running task enqueues a follow-up (continuation)", async () => {
    const queue = createTurnQueue();
    const events: string[] = [];

    const outer = queue.run({
      requestId: "r1",
      trigger: "chat",
      execute: async () => {
        events.push("r1:start");
        // Schedule a continuation without blocking on it synchronously.
        void queue
          .run({
            requestId: "r1-continuation",
            trigger: "continuation",
            execute: async () => {
              events.push("r2:ran");
            },
          })
          .then(() => {
            events.push("r2:settled");
          });
        events.push("r1:end");
      },
    });

    await outer;
    await queue.waitUntilStable();

    expect(events).toEqual(["r1:start", "r1:end", "r2:ran", "r2:settled"]);
  });
});
