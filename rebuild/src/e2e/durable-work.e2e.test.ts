import { describe, expect, it, vi } from "vitest";
import { createMemoryHost, type MemoryHost } from "../adapters/memory/host.js";
import type { IdSource } from "../kernel/ids.js";
import type { FiberRecoveryContext, FiberRecoveryResult } from "../domain/runtime/fibers/fibers.js";
import type { QueueItem } from "../domain/runtime/queue/queue.js";
import { Agent, type AgentHost } from "../app/agent.js";

/**
 * Scenario 2 (audit 24 §2): schedules, queue, and fibers all have to survive
 * "eviction" — a fresh Agent instance constructed over the same durable
 * store/alarm state, with no in-memory carryover from the instance that was
 * running before. This is the load-bearing property behind Durable Object
 * activation semantics that the whole rebuild is standing in for.
 */

function counterIds(): IdSource {
  let n = 0;
  return { newId: (prefix: string) => `${prefix}_${++n}` };
}

function toHost(mem: MemoryHost, opts: Partial<AgentHost> & { className: string; name: string }): AgentHost {
  return {
    store: mem.store,
    alarm: mem.alarms,
    clock: mem.clock,
    ids: counterIds(),
    ...opts,
  };
}

class DurableWorkAgent extends Agent<{ tally: number }> {
  cronFires: number[] = [];
  intervalFires: number[] = [];
  queueOrder: string[] = [];
  flakyAttempts = 0;
  fiberRecoveries: FiberRecoveryContext[] = [];

  protected override getInitialState(): { tally: number } {
    return { tally: 0 };
  }

  async onCronTick(): Promise<void> {
    this.cronFires.push(this.host.clock.now());
  }

  async onIntervalTick(): Promise<void> {
    this.intervalFires.push(this.host.clock.now());
  }

  async flakyTaskA(payload: { tag: string }, _item: QueueItem): Promise<void> {
    this.flakyAttempts += 1;
    if (this.flakyAttempts < 3) throw new Error("not ready yet");
    this.queueOrder.push(payload.tag);
  }

  async taskB(payload: { tag: string }): Promise<void> {
    this.queueOrder.push(payload.tag);
  }

  protected override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<FiberRecoveryResult> {
    this.fiberRecoveries.push(ctx);
    return { status: "completed" };
  }
}

function makeAgent(mem: MemoryHost, name = "worker-1"): DurableWorkAgent {
  const host = toHost(mem, { className: "DurableWorkAgent", name });
  const agent = new DurableWorkAgent(host);
  mem.attachAgent(agent);
  return agent;
}

describe("e2e: durable work survives eviction", () => {
  it("cron and interval schedules recur on a fresh instance after eviction", async () => {
    const mem = createMemoryHost({ agent: "DurableWorkAgent", name: "worker-1" });
    const agent1 = makeAgent(mem);

    agent1.schedule("* * * * *", "onCronTick");
    agent1.scheduleEvery(60, "onIntervalTick");
    await agent1.start();

    mem.clock.advance(60_000);
    await vi.waitFor(() => {
      expect(agent1.cronFires).toHaveLength(1);
      expect(agent1.intervalFires).toHaveLength(1);
    });

    // Simulate eviction: a fresh instance over the same store/alarm/clock,
    // with no in-memory carryover (a brand-new `cronFires`/`intervalFires`).
    const agent2 = makeAgent(mem, "worker-1"); // re-attaching rebinds future alarm fires to agent2
    await agent2.start();

    mem.clock.advance(60_000);
    await vi.waitFor(() => {
      expect(agent2.cronFires).toHaveLength(1);
      expect(agent2.intervalFires).toHaveLength(1);
    });

    // The evicted instance never observes the second occurrence: the
    // schedule rows, not the instance, are what's durable.
    expect(agent1.cronFires).toHaveLength(1);
    expect(agent1.intervalFires).toHaveLength(1);
    expect(agent2.cronFires[0]).toBe(120_000);
    expect(agent2.intervalFires[0]).toBe(120_000);
  });

  it("the task queue drains FIFO and retries a flaky callback before advancing", async () => {
    vi.useFakeTimers();
    try {
      const mem = createMemoryHost({ agent: "DurableWorkAgent", name: "worker-2" });
      const agent = makeAgent(mem, "worker-2");
      await agent.start();

      await agent.queue("flakyTaskA", { tag: "A" });
      await agent.queue("taskB", { tag: "B" });

      // Default queue retry policy: 3 attempts, base delay 1000ms, exponential.
      // Two failures need 1000ms + 2000ms of backoff before the third (successful)
      // attempt runs; only then does FIFO order let "B" through.
      await vi.advanceTimersByTimeAsync(3_500);

      expect(agent.flakyAttempts).toBe(3);
      expect(agent.queueOrder).toEqual(["A", "B"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an interrupted managed fiber recovers on the fresh instance with its last stash", async () => {
    const mem = createMemoryHost({ agent: "DurableWorkAgent", name: "worker-3" });
    const agent1 = makeAgent(mem, "worker-3");
    await agent1.start();

    // Start a managed fiber that checkpoints twice and then never completes,
    // standing in for a closure caught mid-run by an eviction.
    void agent1.startFiber("long-job", async (ctx) => {
      ctx.stash({ step: 1 });
      ctx.stash({ step: 2, note: "halfway" });
      return new Promise<void>(() => {});
    });

    const beforeInspect = agent1.inspectFiber(
      agent1.listFibers({ status: ["running"] })[0]!.fiberId,
    );
    expect(beforeInspect?.snapshot).toEqual({ step: 2, note: "halfway" });

    // Fresh instance, same store: checkInterrupted() (run from start()) finds
    // the orphaned run row (agent2's own FiberService has no live entry for
    // it) and calls onFiberRecovered with the last stashed snapshot.
    const agent2 = makeAgent(mem, "worker-3");
    await agent2.start();

    expect(agent2.fiberRecoveries).toHaveLength(1);
    expect(agent2.fiberRecoveries[0]).toMatchObject({
      name: "long-job",
      snapshot: { step: 2, note: "halfway" },
      recoveryReason: "interrupted",
    });

    // onFiberRecovered's { status: "completed" } settled the managed row.
    const settled = agent2.listFibers({ status: ["completed"] });
    expect(settled.some((f) => f.name === "long-job")).toBe(true);
  });

  it("a duplicate startFiber() with the same idempotency key dedupes instead of re-running", async () => {
    const mem = createMemoryHost({ agent: "DurableWorkAgent", name: "worker-4" });
    const agent = makeAgent(mem, "worker-4");
    await agent.start();

    const ran: string[] = [];
    const first = await agent.startFiber(
      "dedupe-job",
      async () => {
        ran.push("first");
      },
      { idempotencyKey: "job-key-1", waitForCompletion: true },
    );
    const second = await agent.startFiber(
      "dedupe-job",
      async () => {
        ran.push("second");
      },
      { idempotencyKey: "job-key-1", waitForCompletion: true },
    );

    expect(first.accepted).toBe(true);
    expect(first.status).toBe("completed");
    expect(second.accepted).toBe(false);
    expect(second.fiberId).toBe(first.fiberId);
    expect(second.status).toBe("completed");
    expect(ran).toEqual(["first"]);
  });
});
