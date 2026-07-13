import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AbortedError, toErrorValue } from "../kernel/errors.js";
import { createMemoryHost, type MemoryHost } from "../adapters/memory/host.js";
import { createFakeModel } from "../adapters/memory/fake-model.js";
import { createMemoryAgentSpawner } from "../adapters/memory/spawner.js";
import { createEventBus } from "../kernel/events.js";
import type { IdSource } from "../kernel/ids.js";
import type { AgentSpawner } from "../ports/agent-spawner.js";
import type { ModelClient } from "../ports/model.js";
import type { ToolSet } from "../domain/tools/types.js";
import { createSubAgentRegistry } from "../domain/delegation/registry.js";
import { createAgentToolRunService, type AgentToolRun } from "../domain/delegation/runs.js";
import type { AgentHost } from "../app/agent.js";
import { Think, type ChatResponseResult } from "../app/think.js";

/**
 * Scenario 6 (audit 24 §6): parent/child delegation — a parent Think
 * dispatches a chat-capable child Think during a turn via `agentTool()`,
 * backed by `MemoryAgentSpawner`. Uses real Think instances for both parent
 * and child (not stubs), per the priority to exercise the actual composition.
 *
 * One remaining gap (a `summarize()` field-name mismatch found here was
 * fixed in domain/delegation/runs.ts — test 1 asserts the folded summary):
 *
 * - Think has no public entry point that calls `AgentToolRunService.
 *   reconcile()` (contrast with `reconcileScheduledTasks()`, which at least
 *   exists for the declared-tasks service). There is no way, through
 *   Think's public surface, to trigger the "parent eviction reconciles from
 *   a live child" path at all. Test 3 below drives `createAgentToolRunService`
 *   directly (still spawning a *real* Think child through the same
 *   `MemoryAgentSpawner`) as the closest reachable equivalent.
 *
 * Test-only wiring note: `agentTool()`/`startRun()` spawn the child
 * internally (its name is the fresh runId), so there is no seam to inject a
 * per-run FakeModel *after* construction. `ResearcherThink.getModel()` below
 * reads a module-level factory the test sets immediately before triggering
 * the run — the same "configure via shared mutable, single-threaded test
 * file" trick, just applied to a lazily-constructed instance instead of one
 * built with `new` directly.
 */

let childModelFactory: () => ModelClient = () =>
  createFakeModel(() => ({ kind: "text", text: "Default research answer." }));

function counterIds(): IdSource {
  let n = 0;
  return { newId: (prefix: string) => `${prefix}_${++n}` };
}

function toHost(mem: MemoryHost, opts: Partial<AgentHost> & { className: string; name: string }): AgentHost {
  return {
    store: mem.store,
    alarm: mem.alarms,
    connections: mem.connections,
    clock: mem.clock,
    ids: counterIds(),
    ...opts,
  };
}

/**
 * Child contract (audit 19 §"Recovery reconciliation"): the parent's
 * `reconcile()` calls `handle.call("inspectRun", [runId])` expecting
 * `{ status, output?, error? }` reflecting the child's own view of its turn.
 * Think has no built-in `inspectRun` (gap #2 above) — this composes it from
 * Think's public `onChatResponse`/`onChatError` hooks, the intended
 * extension point for a subclass to observe its own turn outcomes.
 */
class ResearcherThink extends Think<unknown> {
  private lazyModel: ModelClient | undefined;
  runStatus: "running" | "completed" | "error" = "running";
  runOutput: string | undefined;
  runErrorMessage: string | undefined;

  protected override getModel(): ModelClient {
    if (!this.lazyModel) this.lazyModel = childModelFactory();
    return this.lazyModel;
  }

  override onChatResponse = async (result: ChatResponseResult): Promise<void> => {
    this.runStatus = "completed";
    this.runOutput = result.message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
  };

  override onChatError = async (error: unknown): Promise<void> => {
    this.runStatus = "error";
    this.runErrorMessage = toErrorValue(error).message;
  };

  async inspectRun(_runId: string): Promise<{ status: "running" | "completed" | "error"; output?: string; error?: string }> {
    if (this.runStatus === "completed") return { status: "completed", output: this.runOutput };
    if (this.runStatus === "error") return { status: "error", error: this.runErrorMessage ?? "unknown error" };
    return { status: "running" };
  }
}

class DelegatingThink extends Think<unknown> {
  model!: ModelClient;

  protected override getModel(): ModelClient {
    return this.model;
  }

  protected override getTools(): ToolSet {
    return {
      research: this.agentTool("ResearcherThink", {
        description: "Delegates a research question to a specialist sub-agent",
        inputSchema: z.object({ topic: z.string() }),
        prompt: (input) => `Research this topic in one sentence: ${(input as { topic: string }).topic}`,
      }),
    };
  }
}

const classMap = {
  DelegatingThink: DelegatingThink as unknown as new (host: unknown) => unknown,
  ResearcherThink: ResearcherThink as unknown as new (host: unknown) => unknown,
};

/** Builds a parent + a MemoryAgentSpawner registered with both classes; each child gets its own isolated store. */
function makeParentAndSpawner(): { parent: DelegatingThink; parentMem: MemoryHost; spawner: AgentSpawner } {
  const parentMem = createMemoryHost({ agent: "DelegatingThink", name: "p1" });
  const spawner = createMemoryAgentSpawner(classMap, (className, name) =>
    toHost(createMemoryHost({ agent: className, name }), { className, name }),
  );
  const parentHost = toHost(parentMem, { className: "DelegatingThink", name: "p1", spawner });
  const parent = new DelegatingThink(parentHost);
  parentMem.attachAgent(parent);
  return { parent, parentMem, spawner };
}

describe("e2e: delegation (agent tools)", () => {
  it("a parent turn delegates via agentTool to a real Think child; the run completes and its events replay in full", async () => {
    childModelFactory = () =>
      createFakeModel(() => ({ kind: "text", text: "Quantum computers use qubits to represent information." }));
    const { parent } = makeParentAndSpawner();
    parent.model = createFakeModel((_req, call) =>
      call === 0
        ? { kind: "tool-call", toolName: "research", input: { topic: "quantum computing" }, id: "call_1" }
        : { kind: "text", text: "I checked with the researcher and have an answer." },
    );

    await parent.start();
    const result = await parent.chat("please research quantum computing", undefined, { requestId: "req_1" });
    expect(result.outcome).toBe("completed");

    // Run registry lifecycle: started, then reaches a terminal "completed" status.
    const runs = parent.listSubAgents("ResearcherThink");
    expect(runs).toHaveLength(1);
    const runId = runs[0]!.name;
    await vi.waitFor(() => {
      expect(parent.inspectAgentToolRun(runId)?.status).toBe("completed");
    });
    const run = parent.inspectAgentToolRun(runId)!;
    expect(run.agentType).toBe("ResearcherThink");

    // Child events are tailable/replayable: the full log in order, and a
    // partial tail from an index returns only what came after it.
    const fullLog = parent.tailAgentToolRun(runId);
    const chunkTypes = fullLog.map((e) => (e.event as { type: string }).type);
    expect(chunkTypes[0]).toBe("start");
    expect(chunkTypes[chunkTypes.length - 1]).toBe("finish");
    const midpoint = Math.floor(fullLog.length / 2);
    const tail = parent.tailAgentToolRun(runId, fullLog[midpoint]!.index);
    expect(tail).toEqual(fullLog.slice(midpoint + 1));

    // The child's streamed text is persisted in the event log, and the run's
    // folded summary — what the parent's tool call returns to the model —
    // is exactly that text.
    const deltas = fullLog
      .map((e) => e.event as { type: string; delta?: string })
      .filter((c) => c.type === "text-delta")
      .map((c) => c.delta)
      .join("");
    expect(deltas.length).toBeGreaterThan(0);
    expect(run.summary).toBe(deltas);

    const parentMessages = await parent.getMessages();
    const toolPart = parentMessages[1]!.parts.find((p) => p.type === "tool-research");
    expect(toolPart).toMatchObject({ state: "output-available", output: deltas });
  });

  it("cancelAgentToolRun aborts an in-flight child turn and settles the run aborted", async () => {
    childModelFactory = () => ({
      async *stream(request) {
        yield { type: "text-delta", text: "researching " };
        await new Promise<never>((_resolve, reject) => {
          if (request.signal?.aborted) {
            reject(new AbortedError("aborted"));
            return;
          }
          request.signal?.addEventListener("abort", () => reject(new AbortedError("aborted")), { once: true });
        });
      },
    });
    const { parent } = makeParentAndSpawner();
    parent.model = createFakeModel([{ kind: "text", text: "unused" }]);
    await parent.start();

    const run = await parent.startAgentToolRun({ agentClassName: "ResearcherThink", prompt: "research forever" });
    // Give the child's own turn a chance to actually start streaming before cancelling.
    await vi.waitFor(() => expect(parent.tailAgentToolRun(run.runId).length).toBeGreaterThan(0));

    await parent.cancelAgentToolRun(run.runId, "no longer needed");

    const settled = parent.inspectAgentToolRun(run.runId);
    expect(settled?.status).toBe("aborted");
    expect(settled?.error).toBe("no longer needed");
  });

  it("(gap workaround, see file header) parent eviction mid-run: reconcile() settles a stale row by asking the live child directly", async () => {
    childModelFactory = () => createFakeModel(() => ({ kind: "text", text: "Reconciled answer." }));
    const mem = createMemoryHost({ agent: "DelegatingThink", name: "p-evict" });
    const spawner = createMemoryAgentSpawner({ ResearcherThink: classMap.ResearcherThink }, (className, name) =>
      toHost(createMemoryHost({ agent: className, name }), { className, name }),
    );
    const registry = createSubAgentRegistry({ store: mem.store, spawner, clock: mem.clock, ids: counterIds() });
    const bus = createEventBus({ agent: "DelegatingThink", name: "p-evict" }, () => mem.clock.now());
    const runsService = createAgentToolRunService({ store: mem.store, registry, clock: mem.clock, ids: counterIds(), bus });

    const started = await runsService.startRun({ agentClassName: "ResearcherThink", prompt: "research this" });
    // The child (a real Think instance, reached through the same spawner)
    // settles its own turn quickly, since its model resolves synchronously.
    await vi.waitFor(() => expect(runsService.inspectRun(started.runId)?.status).toBe("completed"));

    // Simulate a parent eviction that lost the relay's own row update: force
    // the durable row back to "running" (mirroring runs.test.ts's own
    // reconcile fixture, at the app layer with a real child instead of a
    // stub) — Think's relay->settle() path can't be raced deterministically
    // without sleeps, since `onDone()` is what both updates the row *and*
    // triggers this child's own onChatResponse tracking in the same chain.
    const rowKey = `run:row:${started.runId}`;
    const staleRow = mem.store.get<AgentToolRun>(rowKey)!;
    mem.store.put(rowKey, { ...staleRow, status: "running", completedAt: undefined });
    expect(runsService.inspectRun(started.runId)?.status).toBe("running");

    const events: string[] = [];
    bus.subscribe("agentTool", (e) => events.push(e.type));
    await runsService.reconcile();

    const reconciled = runsService.inspectRun(started.runId);
    expect(reconciled?.status).toBe("completed");
    expect(events).toContain("agent_tool:recovery:row");
  });
});
