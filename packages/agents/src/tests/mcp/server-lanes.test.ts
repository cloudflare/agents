import { describe, expect, it } from "vitest";
import {
  ServerLaneCancelledError,
  ServerLanes
} from "../../mcp/client/server-lanes";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ServerLanes", () => {
  it("runs work for one server one item at a time, in order", async () => {
    const lanes = new ServerLanes();
    const order: string[] = [];
    const gate = deferred();

    const first = lanes.run("a", async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
    });
    const second = lanes.run("a", async () => {
      order.push("second");
    });
    await tick();
    expect(order).toEqual(["first:start"]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("runs work for different servers independently", async () => {
    const lanes = new ServerLanes();
    const gate = deferred();
    let otherRan = false;

    const blocked = lanes.run("a", () => gate.promise);
    await lanes.run("b", async () => {
      otherRan = true;
    });
    expect(otherRan).toBe(true);
    gate.resolve();
    await blocked;
  });

  it("starts work on an idle lane synchronously", () => {
    const lanes = new ServerLanes();
    let started = false;
    void lanes.run("a", async () => {
      started = true;
    });
    expect(started).toBe(true);
  });

  it("runs nested work for the same server inline instead of deadlocking", async () => {
    const lanes = new ServerLanes();
    const result = await lanes.run("a", () =>
      lanes.run("a", async () => "nested")
    );
    expect(result).toBe("nested");
  });

  it("queues work started outside the current work's lane permission", async () => {
    const lanes = new ServerLanes();
    const order: string[] = [];
    let queued: Promise<void> | undefined;

    await lanes.run("a", async () => {
      queued = lanes.outside(() =>
        lanes.run("a", async () => {
          order.push("listener");
        })
      );
      await tick();
      order.push("work");
    });
    await queued;
    expect(order).toEqual(["work", "listener"]);
  });

  it("keeps the lane after a rejection and reports it to the caller", async () => {
    const lanes = new ServerLanes();
    await expect(
      lanes.run("a", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    await expect(lanes.run("a", async () => "next")).resolves.toBe("next");
  });

  it("idle() waits for work queued while earlier work settles", async () => {
    const lanes = new ServerLanes();
    const first = deferred();
    const second = deferred();
    void lanes.run("a", () => first.promise);

    let idle = false;
    const waiting = lanes.idle("a").then(() => {
      idle = true;
    });
    void lanes.run("a", () => second.promise);
    first.resolve();
    await tick();
    expect(idle).toBe(false);

    second.resolve();
    await waiting;
    expect(idle).toBe(true);
    expect(lanes.pending()).toHaveLength(0);
  });

  it("forget() cancels work still queued behind running work", async () => {
    const lanes = new ServerLanes();
    const gate = deferred();
    const running = lanes.run("a", () => gate.promise);
    let queuedRan = false;
    const queued = lanes.run("a", async () => {
      queuedRan = true;
    });

    lanes.forget("a");
    gate.resolve();
    await running;
    await expect(queued).rejects.toBeInstanceOf(ServerLaneCancelledError);
    expect(queuedRan).toBe(false);
  });

  it("forget() stops later work from waiting for running work", async () => {
    const lanes = new ServerLanes();
    const gate = deferred();
    void lanes.run("a", () => gate.promise);
    lanes.forget("a");

    let ran = false;
    await lanes.run("a", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    gate.resolve();
  });
});
