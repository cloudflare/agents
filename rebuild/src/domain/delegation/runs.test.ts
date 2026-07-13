import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMemoryAgentSpawner } from "../../adapters/memory/spawner.js";
import { createMemoryKeyValueStore } from "../../adapters/memory/store.js";
import { createTestClock, type TestClock } from "../../adapters/memory/clock.js";
import { createEventBus, type ObservabilityEvent } from "../../kernel/events.js";
import { defaultIdSource } from "../../kernel/ids.js";
import { NotFoundError } from "../../kernel/errors.js";
import { createSubAgentRegistry, type SubAgentRegistry } from "./registry.js";
import { agentTool, createAgentToolRunService, type AgentToolRunService } from "./runs.js";

// ---------------------------------------------------------------------------
// Child relay contract (doc 19 §2): chat(prompt, relay) where
// relay = { onStart({requestId}), onEvent(json), onDone(), onError(err), onInterrupted?() }
// plus cancelChat(requestId). Fake children are scripted via a `behavior`
// closure captured by each test, driving the relay exactly like a real Think
// child would (minus the actual model work).
// ---------------------------------------------------------------------------

interface Relay {
  onStart(info: { requestId: string }): void;
  onEvent(json: unknown): void;
  onDone(): void;
  onError(err: unknown): void;
  onInterrupted?(): void;
}

type Behavior = (relay: Relay, prompt: string, self: ScriptedChild) => void | Promise<void>;

class ScriptedChild {
  static behavior: Behavior = () => {};
  static instances: ScriptedChild[] = [];
  static inspectResult: { status: string; output?: unknown; error?: string } | null | undefined = undefined;
  static failInspect = false;

  relay?: Relay;
  cancelledRequestId?: string;

  constructor(readonly host: unknown) {
    ScriptedChild.instances.push(this);
  }

  async chat(prompt: string, relay: Relay): Promise<void> {
    this.relay = relay;
    await ScriptedChild.behavior(relay, prompt, this);
  }

  async cancelChat(requestId: string): Promise<void> {
    this.cancelledRequestId = requestId;
  }

  async inspectRun(): Promise<{ status: string; output?: unknown; error?: string } | null> {
    if (ScriptedChild.failInspect) throw new Error("unreachable");
    return ScriptedChild.inspectResult ?? null;
  }
}

function resetScript(behavior: Behavior): void {
  ScriptedChild.behavior = behavior;
  ScriptedChild.instances = [];
  ScriptedChild.inspectResult = undefined;
  ScriptedChild.failInspect = false;
}

function harness() {
  const store = createMemoryKeyValueStore();
  const clock = createTestClock(1_000);
  const spawner = createMemoryAgentSpawner({ ScriptedChild }, (className, name) => ({ className, name }));
  const registry: SubAgentRegistry = createSubAgentRegistry({ store, spawner, clock, ids: defaultIdSource });
  const bus = createEventBus({ agent: "parent", name: "p-1" }, () => clock.now());
  const events: ObservabilityEvent[] = [];
  bus.subscribe("*", (e) => events.push(e));
  const liveEvents: Array<{ runId: string; event: unknown }> = [];
  const onRunStart = vi.fn();
  const onRunFinish = vi.fn();
  const onProgress = vi.fn();
  const service: AgentToolRunService = createAgentToolRunService({
    store,
    registry,
    clock,
    ids: defaultIdSource,
    bus,
    onEvent: (runId, event) => liveEvents.push({ runId, event }),
    hooks: { onRunStart, onRunFinish, onProgress },
  });
  return { store, clock, spawner, registry, bus, events, liveEvents, service, onRunStart, onRunFinish, onProgress };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("createAgentToolRunService", () => {
  describe("happy path", () => {
    it("startRun spawns the child (name = runId), relays events, and settles completed on done", async () => {
      resetScript((relay) => {
        relay.onStart({ requestId: "req_1" });
        relay.onEvent({ text: "hello " });
        relay.onEvent({ text: "world" });
        relay.onDone();
      });
      const { service, events, liveEvents, onRunStart, onRunFinish } = harness();

      const run = await service.startRun({ agentClassName: "ScriptedChild", prompt: "hi" });
      expect(run.status).toBe("running");
      expect(run.agentType).toBe("ScriptedChild");
      expect(onRunStart).toHaveBeenCalledWith(expect.objectContaining({ runId: run.runId }));

      const finished = await service.waitForRun(run.runId);

      expect(finished.status).toBe("completed");
      expect(finished.summary).toBe("hello world");
      expect(finished.completedAt).toBeDefined();
      expect(onRunFinish).toHaveBeenCalledWith(expect.objectContaining({ runId: run.runId, status: "completed" }));

      const replay = service.readEvents(run.runId);
      expect(replay).toEqual([
        { index: 0, event: { text: "hello " } },
        { index: 1, event: { text: "world" } },
      ]);
      expect(liveEvents.map((e) => e.event)).toEqual([{ text: "hello " }, { text: "world" }]);
      expect(events.some((e) => e.type === "agent_tool:start")).toBe(true);
      expect(events.some((e) => e.type === "agent_tool:completed")).toBe(true);
    });

    it("readEvents(runId, afterIndex) returns only later events (tail replay)", async () => {
      resetScript((relay) => {
        relay.onStart({ requestId: "req_1" });
        relay.onEvent({ n: 1 });
        relay.onEvent({ n: 2 });
        relay.onEvent({ n: 3 });
        relay.onDone();
      });
      const { service } = harness();
      const run = await service.startRun({ agentClassName: "ScriptedChild", prompt: "hi" });
      await service.waitForRun(run.runId);

      const tail = service.readEvents(run.runId, 0);
      expect(tail).toEqual([
        { index: 1, event: { n: 2 } },
        { index: 2, event: { n: 3 } },
      ]);
    });

    it("waitForRun resolves immediately for an already-terminal run", async () => {
      resetScript((relay) => {
        relay.onDone();
      });
      const { service } = harness();
      const run = await service.startRun({ agentClassName: "ScriptedChild", prompt: "hi" });
      await service.waitForRun(run.runId);

      const again = await service.waitForRun(run.runId);
      expect(again.status).toBe("completed");
    });

    it("onEvent payloads carrying `progress` invoke the onProgress hook", async () => {
      resetScript((relay) => {
        relay.onStart({ requestId: "req_1" });
        relay.onEvent({ progress: 0.5 });
        relay.onDone();
      });
      const { service, onProgress } = harness();
      const run = await service.startRun({ agentClassName: "ScriptedChild", prompt: "hi" });
      await service.waitForRun(run.runId);

      expect(onProgress).toHaveBeenCalledWith(run.runId, 0.5);
    });
  });

  describe("error path", () => {
    it("child onError() settles the run as error", async () => {
      resetScript((relay) => {
        relay.onStart({ requestId: "req_1" });
        relay.onError(new Error("kaboom"));
      });
      const { service, events } = harness();
      const run = await service.startRun({ agentClassName: "ScriptedChild", prompt: "hi" });

      const finished = await service.waitForRun(run.runId);
      expect(finished.status).toBe("error");
      expect(finished.error).toBe("kaboom");
      expect(events.some((e) => e.type === "agent_tool:error")).toBe(true);
    });

    it("the child's chat() throwing settles the run as error", async () => {
      resetScript(() => {
        throw new Error("thrown synchronously");
      });
      const { service } = harness();
      const run = await service.startRun({ agentClassName: "ScriptedChild", prompt: "hi" });

      const finished = await service.waitForRun(run.runId);
      expect(finished.status).toBe("error");
      expect(finished.error).toContain("thrown synchronously");
    });
  });

  describe("cancel", () => {
    it("cancelRun mid-run calls cancelChat(requestId) and settles aborted immediately", async () => {
      let started = false;
      resetScript((relay) => {
        relay.onStart({ requestId: "req_1" });
        started = true;
        // never calls onDone/onError: simulates a long-running child
        return new Promise(() => {});
      });
      const { service, registry, events } = harness();
      const run = await service.startRun({ agentClassName: "ScriptedChild", prompt: "hi" });
      await flush();
      expect(started).toBe(true);

      await service.cancelRun(run.runId, "user cancelled");

      const finished = service.inspectRun(run.runId);
      expect(finished?.status).toBe("aborted");
      expect(events.some((e) => e.type === "agent_tool:aborted")).toBe(true);

      const child = registry.get("ScriptedChild", run.runId) as unknown as { call: (m: string, a: unknown[]) => Promise<unknown> };
      void child;
      const instance = ScriptedChild.instances.find((c) => true);
      expect(instance?.cancelledRequestId).toBe("req_1");
    });

    it("cancelRun without a known requestId aborts the handle instead", async () => {
      resetScript(() => new Promise(() => {})); // never calls onStart
      const { service } = harness();
      const run = await service.startRun({ agentClassName: "ScriptedChild", prompt: "hi" });
      await flush();

      await service.cancelRun(run.runId);

      expect(service.inspectRun(run.runId)?.status).toBe("aborted");
    });

    it("cancelRun on an unknown runId throws NotFoundError", async () => {
      const { service } = harness();
      await expect(service.cancelRun("nope")).rejects.toThrow(NotFoundError);
    });
  });

  describe("interrupted", () => {
    it("onInterrupted() leaves the run running; a later onDone() settles it", async () => {
      resetScript((relay) => {
        relay.onStart({ requestId: "req_1" });
        relay.onEvent({ text: "partial" });
        relay.onInterrupted?.();
      });
      const { service } = harness();
      const run = await service.startRun({ agentClassName: "ScriptedChild", prompt: "hi" });
      await flush();

      expect(service.inspectRun(run.runId)?.status).toBe("running");

      // A later continuation settles the run for real (same relay instance,
      // exactly as a recovered child continuation would call back).
      const child = ScriptedChild.instances[0]!;
      child.relay!.onEvent({ text: " more" });
      child.relay!.onDone();

      const finished = await service.waitForRun(run.runId);
      expect(finished.status).toBe("completed");
      expect(finished.summary).toBe("partial more");
    });
  });

  describe("listRuns / inspectRun", () => {
    it("inspectRun returns null for an unknown runId", () => {
      const { service } = harness();
      expect(service.inspectRun("nope")).toBeNull();
    });

    it("listRuns filters by status", async () => {
      resetScript((relay) => relay.onDone());
      const { service } = harness();
      const a = await service.startRun({ agentClassName: "ScriptedChild", prompt: "a" });
      await service.waitForRun(a.runId);

      resetScript(() => new Promise(() => {}));
      const b = await service.startRun({ agentClassName: "ScriptedChild", prompt: "b" });
      await flush();

      const running = service.listRuns({ status: ["running"] });
      expect(running.map((r) => r.runId)).toEqual([b.runId]);

      const completed = service.listRuns({ status: ["completed"] });
      expect(completed.map((r) => r.runId)).toEqual([a.runId]);

      expect(service.listRuns()).toHaveLength(2);
    });
  });

  describe("clearRuns", () => {
    it("deletes run rows + event logs and destroys the retained child instances", async () => {
      resetScript((relay) => {
        relay.onEvent({ text: "x" });
        relay.onDone();
      });
      const { service, registry, spawner } = harness();
      const run = await service.startRun({ agentClassName: "ScriptedChild", prompt: "hi" });
      await service.waitForRun(run.runId);
      expect(registry.has("ScriptedChild", run.runId)).toBe(true);

      const removed = await service.clearRuns();

      expect(removed).toBe(1);
      expect(service.inspectRun(run.runId)).toBeNull();
      expect(service.readEvents(run.runId)).toEqual([]);

      // destroyed: a fresh spawner.get() constructs a brand-new instance
      const before = ScriptedChild.instances.length;
      spawner.get("ScriptedChild", run.runId);
      expect(ScriptedChild.instances.length).toBe(before + 1);
    });

    it("honors a statuses filter", async () => {
      resetScript((relay) => relay.onDone());
      const { service } = harness();
      const done = await service.startRun({ agentClassName: "ScriptedChild", prompt: "a" });
      await service.waitForRun(done.runId);

      resetScript(() => new Promise(() => {}));
      const running = await service.startRun({ agentClassName: "ScriptedChild", prompt: "b" });
      await flush();

      const removed = await service.clearRuns({ statuses: ["completed"] });
      expect(removed).toBe(1);
      expect(service.inspectRun(done.runId)).toBeNull();
      expect(service.inspectRun(running.runId)?.status).toBe("running");
    });
  });

  describe("reconcile", () => {
    it("settles a stale running row from a live child's inspectRun()", async () => {
      resetScript(() => new Promise(() => {}));
      const { service, store, registry, clock, bus, events } = harness();
      const run = await service.startRun({ agentClassName: "ScriptedChild", prompt: "hi" });
      await flush();
      expect(service.inspectRun(run.runId)?.status).toBe("running");

      ScriptedChild.inspectResult = { status: "completed", output: { done: true } };

      // Simulate a fresh service instance (as if the parent restarted): same
      // store/registry, new closures.
      const revived = createAgentToolRunService({ store, registry, clock, ids: defaultIdSource, bus });
      await revived.reconcile();

      expect(revived.inspectRun(run.runId)?.status).toBe("completed");
      expect(revived.inspectRun(run.runId)?.output).toEqual({ done: true });
      expect(events.some((e) => e.type === "agent_tool:recovery:begin")).toBe(true);
      expect(events.some((e) => e.type === "agent_tool:recovery:complete")).toBe(true);
      expect(events.some((e) => e.type === "agent_tool:recovery:row")).toBe(true);
    });

    it("marks an unreachable/unknown child as error(\"lost\")", async () => {
      resetScript(() => new Promise(() => {}));
      const { service, store, registry, clock, bus } = harness();
      const run = await service.startRun({ agentClassName: "ScriptedChild", prompt: "hi" });
      await flush();

      ScriptedChild.inspectResult = null; // child reports unknown state

      const revived = createAgentToolRunService({ store, registry, clock, ids: defaultIdSource, bus });
      await revived.reconcile();

      const finished = revived.inspectRun(run.runId);
      expect(finished?.status).toBe("error");
      expect(finished?.error).toBe("lost");
    });
  });
});

describe("agentTool", () => {
  it("execute() runs the child to completion and returns its summary as output", async () => {
    resetScript((relay) => {
      relay.onEvent({ text: "the answer is 42" });
      relay.onDone();
    });
    const { service } = harness();
    const inputSchema = z.object({ question: z.string() });
    const t = agentTool(
      "ScriptedChild",
      { description: "delegate to a sub-agent", inputSchema, prompt: (input) => (input as { question: string }).question },
      { runs: service }
    );

    const ctx = { toolCallId: "tc_1", requestId: "req_1", messages: [], signal: new AbortController().signal };
    const output = await t.execute!({ question: "what?" }, ctx);

    expect(output).toBe("the answer is 42");
  });

  it("execute() surfaces a structured error when the child run errors", async () => {
    resetScript((relay) => {
      relay.onError(new Error("boom"));
    });
    const { service } = harness();
    const t = agentTool(
      "ScriptedChild",
      { description: "delegate", inputSchema: z.object({}) },
      { runs: service }
    );

    const ctx = { toolCallId: "tc_1", requestId: "req_1", messages: [], signal: new AbortController().signal };
    const output = await t.execute!({}, ctx);

    expect(output).toMatchObject({ error: { message: "boom" } });
  });

  it("defaults the prompt to JSON.stringify(input) when no prompt builder is given", async () => {
    let seenPrompt: string | undefined;
    resetScript((relay, prompt) => {
      seenPrompt = prompt;
      relay.onDone();
    });
    const { service } = harness();
    const t = agentTool("ScriptedChild", { description: "delegate", inputSchema: z.object({ x: z.number() }) }, { runs: service });

    const ctx = { toolCallId: "tc_1", requestId: "req_1", messages: [], signal: new AbortController().signal };
    await t.execute!({ x: 1 }, ctx);

    expect(seenPrompt).toBe(JSON.stringify({ x: 1 }));
  });
});
