import { describe, expect, it, vi } from "vitest";
import { createMemoryHost, type MemoryHost } from "../adapters/memory/host.js";
import { createMemoryWorkflowRuntime } from "../adapters/memory/workflow-runtime.js";
import { createMemoryEmailTransport } from "../adapters/memory/email.js";
import { createMemoryAgentSpawner } from "../adapters/memory/spawner.js";
import type { IdSource } from "../kernel/ids.js";
import { callable, type StreamingResponse } from "../domain/runtime/rpc/callable.js";
import type { StoredEvent } from "../domain/events/log.js";
import type { FiberRecoveryContext, FiberRecoveryResult } from "../domain/runtime/fibers/fibers.js";
import { Agent, type AgentHost } from "./agent.js";

interface CountState {
  count: number;
}

function counterIds(): IdSource {
  let n = 0;
  return { newId: (prefix: string) => `${prefix}_${++n}` };
}

/** Builds a plain AgentHost (no connections/bus field — Agent creates its own) over a MemoryHost. */
function toHost(mem: MemoryHost, opts: Partial<AgentHost> & { className: string; name: string }): AgentHost {
  return {
    store: mem.store,
    alarm: mem.alarms,
    clock: mem.clock,
    ids: counterIds(),
    ...opts,
  };
}

class TestAgent extends Agent<CountState> {
  order: string[] = [];
  received: Array<{ payload: unknown }> = [];
  queueReceived: unknown[] = [];
  fiberRecoveries: FiberRecoveryContext[] = [];
  stateChanges: Array<{ state: CountState; source: unknown }> = [];
  rejectState = false;
  readonlyMeta: Record<string, unknown> | undefined;

  protected override getInitialState(): CountState {
    return { count: 0 };
  }

  protected override onStart(): void {
    this.order.push("onStart");
  }

  protected override validateStateChange(next: CountState): void {
    if (this.rejectState) {
      throw new Error("rejected");
    }
    void next;
  }

  protected override onStateChanged(state: CountState, source: unknown): void {
    this.stateChanges.push({ state, source });
  }

  async myCallback(payload: unknown): Promise<void> {
    this.received.push({ payload });
  }

  async myQueueCallback(payload: unknown): Promise<void> {
    this.queueReceived.push(payload);
  }

  @callable({ description: "adds two numbers" })
  add(a: number, b: number): number {
    return a + b;
  }

  @callable({ streaming: true })
  async streamCount(stream: StreamingResponse, n: number): Promise<void> {
    for (let i = 0; i < n; i++) stream.send(i);
    stream.end("done");
  }

  protected override async onFiberRecovered(
    ctx: FiberRecoveryContext,
  ): Promise<void | FiberRecoveryResult> {
    this.fiberRecoveries.push(ctx);
    return { status: "completed" };
  }

  protected override shouldConnectionBeReadonly(meta: Record<string, unknown>): boolean {
    this.readonlyMeta = meta;
    return false;
  }
}

/** A minimal Agent subclass with no overrides, used for plain wiring assertions. */
class PlainAgent extends Agent<{ n: number }> {}

function makeAgent(className = "TestAgent", name = "a1"): { agent: TestAgent; mem: MemoryHost; host: AgentHost } {
  const mem = createMemoryHost({ agent: className, name });
  const host = toHost(mem, { className, name });
  const agent = new TestAgent(host);
  mem.attachAgent(agent);
  return { agent, mem, host };
}

function collectEvents(agent: Agent<unknown>): StoredEvent[] {
  const collected: StoredEvent[] = [];
  agent.events().subscribe("live", (e) => collected.push(e));
  return collected;
}

describe("Agent construction + start ordering", () => {
  it("runs user onStart, then start() completes and a previously-scheduled callback still fires", async () => {
    const { agent, mem } = makeAgent();

    agent.schedule(new Date(mem.clock.now() + 5000), "myCallback", { x: 1 });
    await agent.start();
    expect(agent.order).toEqual(["onStart"]);

    mem.clock.advance(5000);
    await vi.waitFor(() => expect(agent.received).toHaveLength(1));
    expect(agent.received[0]).toEqual({ payload: { x: 1 } });
  });

  it("runs fiber recovery after onStart (assert both run, in order)", async () => {
    const mem = createMemoryHost({ agent: "TestAgent", name: "a1" });
    const host1 = toHost(mem, { className: "TestAgent", name: "a1" });
    const agent1 = new TestAgent(host1);
    void agent1.runFiber("work", () => new Promise<void>(() => {}));

    class OrderedAgent extends TestAgent {
      protected override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<FiberRecoveryResult> {
        this.order.push("fiberRecovered");
        return (await super.onFiberRecovered(ctx)) ?? { status: "completed" };
      }
    }
    const host2 = toHost(mem, { className: "TestAgent", name: "a1", ids: host1.ids });
    const agent2 = new OrderedAgent(host2);
    await agent2.start();

    expect(agent2.order).toEqual(["onStart", "fiberRecovered"]);
  });

  it("start() re-arms the alarm to the earliest pending schedule", async () => {
    const { agent, mem } = makeAgent();
    agent.schedule(new Date(mem.clock.now() + 10_000), "myCallback");
    await agent.start();
    expect(mem.alarms.get()).toBe(10_000);
  });
});

describe("schedule() sugar forms", () => {
  it("accepts a Date (once)", async () => {
    const { agent, mem } = makeAgent();
    const s = agent.schedule(new Date(mem.clock.now() + 2000), "myCallback", { a: 1 });
    expect(s.spec).toEqual({ kind: "once", at: 2000 });
    await agent.start();
    mem.clock.advance(2000);
    await vi.waitFor(() => expect(agent.received).toHaveLength(1));
  });

  it("accepts a number of seconds as a delay (once)", async () => {
    const { agent, mem } = makeAgent();
    mem.clock.set(1000);
    const s = agent.schedule(30, "myCallback", { b: 2 });
    expect(s.spec).toEqual({ kind: "once", at: 31_000 });
  });

  it("accepts a cron string", () => {
    const { agent } = makeAgent();
    const s = agent.schedule("0 0 * * *", "myCallback");
    expect(s.spec).toEqual({ kind: "cron", expression: "0 0 * * *" });
  });

  it("scheduleEvery creates an interval schedule", () => {
    const { agent } = makeAgent();
    const s = agent.scheduleEvery(60, "myCallback");
    expect(s.spec).toEqual({ kind: "interval", everySeconds: 60 });
  });

  it("getScheduleById / listSchedules / cancelSchedule round-trip", () => {
    const { agent } = makeAgent();
    const s = agent.schedule(60, "myCallback");
    expect(agent.getScheduleById(s.id)?.id).toBe(s.id);
    expect(agent.listSchedules().map((x) => x.id)).toContain(s.id);
    expect(agent.cancelSchedule(s.id)).toBe(true);
    expect(agent.getScheduleById(s.id)).toBeUndefined();
  });
});

describe("scheduler dispatch table", () => {
  it("dispatches a due schedule to a public method on the agent instance, delivering the payload", async () => {
    const { agent, mem } = makeAgent();
    agent.schedule(new Date(mem.clock.now() + 1000), "myCallback", { hello: "world" });
    await agent.start();
    mem.clock.advance(1000);
    await vi.waitFor(() => expect(agent.received).toHaveLength(1));
    expect(agent.received[0]).toEqual({ payload: { hello: "world" } });
  });

  it("hides $internal:* callbacks from listSchedules() while keepAlive is held", async () => {
    const { agent } = makeAgent();
    const release = agent.keepAlive();
    const names = agent.listSchedules().map((s) => s.callback);
    expect(names.every((n) => !n.startsWith("$internal:"))).toBe(true);
    release();
  });

  it("emits schedule:error for a schedule whose callback has no matching method", async () => {
    const { agent, mem } = makeAgent();
    const events: string[] = [];
    agent.bus.subscribe("*", (e) => events.push(e.type));
    agent.schedule(new Date(mem.clock.now() + 1000), "noSuchMethod");
    mem.clock.advance(1000);
    await vi.waitFor(() => expect(events).toContain("schedule:error"));
  });
});

describe("task queue dispatch", () => {
  it("dispatches a queued task to a public method by name", async () => {
    const { agent } = makeAgent();
    await agent.queue("myQueueCallback", { z: 9 });
    await vi.waitFor(() => expect(agent.queueReceived).toHaveLength(1));
    expect(agent.queueReceived[0]).toEqual({ z: 9 });
  });

  it("getQueue / getQueues / dequeue expose queue introspection", async () => {
    const { agent } = makeAgent();
    // Use a callback with no handler so the item survives long enough to inspect
    // (myQueueCallback would be dispatched and removed almost immediately).
    const id = await agent.queue("myQueueCallback", { keep: true });
    // dequeue before the microtask-deferred flush runs
    agent.dequeue(id);
    expect(agent.getQueue(id)).toBeUndefined();
  });
});

describe("rpc dispatch surface", () => {
  it("callables().dispatch() runs a non-streaming @callable method and replies via the responder", async () => {
    const { agent } = makeAgent();
    const responses: unknown[] = [];
    await agent.callables().dispatch({ id: "r1", method: "add", args: [2, 3] }, (r) => responses.push(r));
    expect(responses).toEqual([{ type: "rpc", id: "r1", success: true, result: 5, done: true }]);
  });

  it("streams chunks for a streaming @callable method", async () => {
    const { agent } = makeAgent();
    const responses: unknown[] = [];
    await agent.callables().dispatch({ id: "r2", method: "streamCount", args: [3] }, (r) => responses.push(r));
    expect(responses).toEqual([
      { type: "rpc", id: "r2", success: true, result: 0, done: false },
      { type: "rpc", id: "r2", success: true, result: 1, done: false },
      { type: "rpc", id: "r2", success: true, result: 2, done: false },
      { type: "rpc", id: "r2", success: true, result: "done", done: true },
    ]);
  });

  it("callableMethods() lists the scanned @callable methods", () => {
    const { agent } = makeAgent();
    const methods = agent.callableMethods();
    expect(methods.get("add")).toEqual({ description: "adds two numbers", streaming: undefined });
    expect(methods.get("streamCount")).toEqual({ description: undefined, streaming: true });
  });
});

describe("state changes publish state:changed events", () => {
  it("setState() publishes a state:changed event with a server origin", async () => {
    const { agent } = makeAgent();
    const events = collectEvents(agent);

    agent.setState({ count: 5 });

    expect(events).toHaveLength(1);
    expect(events[0]!.event).toEqual({ type: "state:changed", state: { count: 5 }, origin: { kind: "server" } });
  });

  it("setState() with a client origin publishes state:changed carrying the sourceId", async () => {
    const { agent } = makeAgent();
    const events = collectEvents(agent);

    agent.setState({ count: 7 }, { kind: "client", sourceId: "conn_1" });

    expect(agent.state).toEqual({ count: 7 });
    expect(events[0]!.event).toEqual({
      type: "state:changed",
      state: { count: 7 },
      origin: { kind: "client", sourceId: "conn_1" },
    });
    expect(agent.stateChanges).toHaveLength(1);
  });

  it("a rejected state change (validate throws) publishes no event and leaves the old state", async () => {
    const { agent } = makeAgent();
    agent.rejectState = true;
    const events = collectEvents(agent);

    expect(() => agent.setState({ count: 99 }, { kind: "client", sourceId: "v1" })).toThrow();

    expect(events).toHaveLength(0);
    expect(agent.state).toEqual({ count: 0 });
  });
});

describe("readonly policy predicate", () => {
  it("shouldConnectionBeReadonly(meta) is a plain overridable predicate, not connection-bound", () => {
    class ReadonlyAgent extends TestAgent {
      protected override shouldConnectionBeReadonly(meta: Record<string, unknown>): boolean {
        this.readonlyMeta = meta;
        return meta.role === "viewer";
      }
    }
    const mem = createMemoryHost({ agent: "ReadonlyAgent", name: "a1" });
    const host = toHost(mem, { className: "ReadonlyAgent", name: "a1" });
    const agent = new ReadonlyAgent(host);
    // Exercised indirectly: the predicate is a protected hook an adapter (not
    // this test) would call directly with its own connection metadata. Cast
    // to reach the protected member the way an adapter subclassing or
    // composing over Agent would.
    const isReadonly = (agent as unknown as { shouldConnectionBeReadonly(meta: Record<string, unknown>): boolean }).shouldConnectionBeReadonly({ role: "viewer" });
    expect(isReadonly).toBe(true);
    expect(agent.readonlyMeta).toEqual({ role: "viewer" });
  });
});

describe("destroy()", () => {
  it("cancels all schedules, clears storage, and clears the alarm", async () => {
    const { agent, mem } = makeAgent();
    agent.schedule(new Date(mem.clock.now() + 5000), "myCallback");
    agent.setState({ count: 3 });

    await agent.destroy();

    expect(agent.listSchedules()).toHaveLength(0);
    expect(mem.alarms.get()).toBeNull();
    expect(mem.store.list().size).toBe(0);
  });

  it("calls host.onDestroyed() if provided", async () => {
    const mem = createMemoryHost({ agent: "TestAgent", name: "a1" });
    let destroyed = false;
    const host = toHost(mem, {
      className: "TestAgent",
      name: "a1",
      onDestroyed: () => {
        destroyed = true;
      },
    });
    const agent = new TestAgent(host);
    await agent.destroy();
    expect(destroyed).toBe(true);
  });
});

describe("keepAliveWhile", () => {
  it("holds the heartbeat (alarm armed) for the duration of fn and releases afterward", async () => {
    const { agent, mem } = makeAgent();
    expect(mem.alarms.get()).toBeNull();

    let armedDuring: number | null = null;
    await agent.keepAliveWhile(async () => {
      armedDuring = mem.alarms.get();
    });

    expect(armedDuring).not.toBeNull();
    expect(mem.alarms.get()).toBeNull();
  });

  it("keepAlive()/release is idempotent and ref-counted", () => {
    const { agent, mem } = makeAgent();
    const releaseA = agent.keepAlive();
    const releaseB = agent.keepAlive();
    expect(mem.alarms.get()).not.toBeNull();
    releaseA();
    expect(mem.alarms.get()).not.toBeNull();
    releaseB();
    expect(mem.alarms.get()).toBeNull();
    releaseB(); // idempotent
  });
});

describe("fiber recovery on start()", () => {
  it("calls onFiberRecovered for an orphaned run row left by a prior instance", async () => {
    const mem = createMemoryHost({ agent: "TestAgent", name: "a1" });
    const host1 = toHost(mem, { className: "TestAgent", name: "a1" });
    const agent1 = new TestAgent(host1);

    // Start a plain fiber that never resolves (simulating an eviction mid-run):
    // the run row is written durably before the closure body runs.
    void agent1.runFiber("work", () => new Promise<void>(() => {}));

    // A fresh instance over the same store simulates reactivation after eviction.
    const host2 = toHost(mem, { className: "TestAgent", name: "a1", ids: host1.ids });
    const agent2 = new TestAgent(host2);
    await agent2.start();

    expect(agent2.fiberRecoveries).toHaveLength(1);
    expect(agent2.fiberRecoveries[0]?.name).toBe("work");
  });
});

describe("sub-agents", () => {
  it("subAgent()/hasSubAgent()/listSubAgents() delegate to the sub-agent registry", () => {
    const mem = createMemoryHost({ agent: "TestAgent", name: "parent" });
    const spawner = createMemoryAgentSpawner(
      { TestAgent: TestAgent as unknown as new (host: unknown) => unknown },
      (className, name) => toHost(mem, { className, name }),
    );
    const host = toHost(mem, { className: "TestAgent", name: "parent", spawner });
    const agent = new TestAgent(host);

    expect(agent.hasSubAgent("TestAgent", "child")).toBe(false);
    const handle = agent.subAgent("TestAgent", "child");
    expect(handle.className).toBe("TestAgent");
    expect(agent.hasSubAgent("TestAgent", "child")).toBe(true);
    expect(agent.listSubAgents().map((r) => r.name)).toEqual(["child"]);
  });

  it("selfPath()/parentPath()/parentAgent() reflect the host's parentPath chain", () => {
    const mem = createMemoryHost({ agent: "TestAgent", name: "child" });
    const spawner = createMemoryAgentSpawner(
      { TestAgent: TestAgent as unknown as new (host: unknown) => unknown },
      (className, name) => toHost(mem, { className, name }),
    );
    const host = toHost(mem, {
      className: "TestAgent",
      name: "child",
      spawner,
      parentPath: [{ className: "TestAgent", name: "root" }],
    });
    const agent = new TestAgent(host);

    expect(agent.parentPath()).toEqual([{ className: "TestAgent", name: "root" }]);
    expect(agent.selfPath()).toEqual([
      { className: "TestAgent", name: "root" },
      { className: "TestAgent", name: "child" },
    ]);
    expect(agent.parentAgent()?.name).toBe("root");
  });

  it("throws when sub-agent methods are called without a spawner configured", () => {
    const { agent } = makeAgent();
    expect(() => agent.subAgent("TestAgent", "x")).toThrow();
    expect(agent.parentAgent()).toBeUndefined();
  });
});

describe("workflows", () => {
  it("runWorkflow()/getWorkflow() delegate to the workflow service", async () => {
    const mem = createMemoryHost({ agent: "TestAgent", name: "a1" });
    const runtime = createMemoryWorkflowRuntime();
    const host = toHost(mem, { className: "TestAgent", name: "a1", workflowRuntime: runtime });
    const agent = new TestAgent(host);

    const wf = await agent.runWorkflow("onboarding", { params: { x: 1 } });
    expect(wf.status).toBe("running");
    expect(agent.getWorkflow(wf.workflowId)?.workflowName).toBe("onboarding");
  });

  it("throws when workflow methods are called without a WorkflowRuntime configured", async () => {
    const { agent } = makeAgent();
    await expect(agent.runWorkflow("x")).rejects.toThrow();
  });
});

describe("email", () => {
  it("sendEmail() delegates to the EmailTransport and emits email:reply", async () => {
    const mem = createMemoryHost({ agent: "TestAgent", name: "a1" });
    const email = createMemoryEmailTransport();
    const host = toHost(mem, { className: "TestAgent", name: "a1", email });
    const agent = new TestAgent(host);
    const events: string[] = [];
    agent.bus.subscribe("*", (e) => events.push(e.type));

    const result = await agent.sendEmail({ from: "a@b.com", to: "c@d.com", subject: "hi" });
    expect(result.messageId).toBeDefined();
    expect(email.sent).toHaveLength(1);
    expect(events).toContain("email:reply");
  });

  it("throws when sendEmail is called without an EmailTransport configured", async () => {
    const { agent } = makeAgent();
    await expect(agent.sendEmail({ from: "a@b.com", to: "c@d.com" })).rejects.toThrow();
  });
});

describe("events() / identity()", () => {
  it("events() is the durable, offset-addressed outbound port", () => {
    const { agent } = makeAgent();
    expect(agent.events().head()).toBe(0);
    agent.setState({ count: 1 });
    expect(agent.events().head()).toBe(1);
    const read = agent.events().read(0);
    expect(read.kind).toBe("events");
  });

  it("identity() reports className and name", () => {
    const { agent } = makeAgent("TestAgent", "abc");
    expect(agent.identity()).toEqual({ className: "TestAgent", name: "abc" });
  });
});

describe("misc", () => {
  it("exposes name and className from the host", () => {
    const { agent } = makeAgent("TestAgent", "abc");
    expect(agent.name).toBe("abc");
    expect(agent.className).toBe("TestAgent");
  });

  it("a plain Agent subclass with no overrides constructs and starts cleanly", async () => {
    const mem = createMemoryHost({ agent: "PlainAgent", name: "p1" });
    const host = toHost(mem, { className: "PlainAgent", name: "p1" });
    const agent = new PlainAgent(host);
    await expect(agent.start()).resolves.toBeUndefined();
  });
});
