import { describe, expect, it } from "vitest";
import { createMemoryKeyValueStore } from "../../adapters/memory/store.js";
import { createTestClock } from "../../adapters/memory/clock.js";
import { createMemoryWorkflowRuntime } from "../../adapters/memory/workflow-runtime.js";
import { createEventBus, type ObservabilityEvent } from "../../kernel/events.js";
import { defaultIdSource } from "../../kernel/ids.js";
import { createWorkflowService, type WorkflowInfo } from "./workflows.js";

function harness(hooks?: Parameters<typeof createWorkflowService>[0]["hooks"]) {
  const store = createMemoryKeyValueStore();
  const runtime = createMemoryWorkflowRuntime();
  const clock = createTestClock(1_000);
  const bus = createEventBus({ agent: "test", name: "agent-1" }, () => clock.now());
  const events: ObservabilityEvent[] = [];
  bus.subscribe("*", (e) => events.push(e));
  const service = createWorkflowService({
    store,
    runtime,
    clock,
    ids: defaultIdSource,
    bus,
    hooks,
  });
  return { store, runtime, clock, bus, events, service };
}

describe("createWorkflowService", () => {
  describe("run", () => {
    it("inserts a tracking row, delegates to the runtime, and emits workflow:start", async () => {
      const { runtime, events, service } = harness();

      const info = await service.run("onboarding", { id: "wf_1", params: { a: 1 }, metadata: { m: true } });

      expect(info).toMatchObject({
        workflowId: "wf_1",
        workflowName: "onboarding",
        status: "running",
        params: { a: 1 },
        metadata: { m: true },
      });
      expect(await runtime.status("onboarding", "wf_1")).toEqual({ status: "running" });
      expect(events.some((e) => e.type === "workflow:start" && e.payload.workflowId === "wf_1")).toBe(true);
    });

    it("defaults the id to a newly generated one when omitted", async () => {
      const { service } = harness();
      const info = await service.run("onboarding");
      expect(typeof info.workflowId).toBe("string");
      expect(info.workflowId.length).toBeGreaterThan(0);
    });

    it("throws ConflictError when reusing an id that still has a live row", async () => {
      const { service } = harness();
      await service.run("onboarding", { id: "wf_1" });
      await expect(service.run("onboarding", { id: "wf_1" })).rejects.toThrow(/live/i);
    });

    it("allows reusing an id once the previous run has settled", async () => {
      const { service } = harness();
      await service.run("onboarding", { id: "wf_1" });
      await service.terminate("wf_1");
      const info = await service.run("onboarding", { id: "wf_1" });
      expect(info.status).toBe("running");
    });
  });

  describe("control methods", () => {
    it("sendEvent forwards to the runtime and emits workflow:event without changing status", async () => {
      const { runtime, events, service } = harness();
      await service.run("onboarding", { id: "wf_1" });

      await service.sendEvent("wf_1", { type: "custom", payload: { x: 1 } });

      expect(runtime.eventsFor("onboarding", "wf_1")).toEqual([{ type: "custom", payload: { x: 1 } }]);
      expect(service.get("wf_1")?.status).toBe("running");
      expect(events.some((e) => e.type === "workflow:event")).toBe(true);
    });

    it("approve() sends a reserved approval event and emits workflow:approved", async () => {
      const { runtime, events, service } = harness();
      await service.run("onboarding", { id: "wf_1" });

      await service.approve("wf_1", "looks good");

      expect(runtime.eventsFor("onboarding", "wf_1")).toEqual([
        { type: "approval", payload: { approved: true, reason: "looks good" } },
      ]);
      expect(events.some((e) => e.type === "workflow:approved")).toBe(true);
    });

    it("reject() sends a reserved approval event and emits workflow:rejected", async () => {
      const { runtime, events, service } = harness();
      await service.run("onboarding", { id: "wf_1" });

      await service.reject("wf_1", "nope");

      expect(runtime.eventsFor("onboarding", "wf_1")).toEqual([
        { type: "approval", payload: { approved: false, reason: "nope" } },
      ]);
      expect(events.some((e) => e.type === "workflow:rejected")).toBe(true);
    });

    it("terminate/pause/resume/restart transition status and emit events", async () => {
      const { events, service } = harness();
      await service.run("onboarding", { id: "wf_1" });

      await service.pause("wf_1");
      expect(service.get("wf_1")?.status).toBe("paused");
      expect(events.some((e) => e.type === "workflow:paused")).toBe(true);

      await service.resume("wf_1");
      expect(service.get("wf_1")?.status).toBe("running");
      expect(events.some((e) => e.type === "workflow:resumed")).toBe(true);

      await service.terminate("wf_1");
      expect(service.get("wf_1")?.status).toBe("terminated");
      expect(events.some((e) => e.type === "workflow:terminated")).toBe(true);

      await service.restart("wf_1");
      expect(service.get("wf_1")?.status).toBe("running");
      expect(events.some((e) => e.type === "workflow:restarted")).toBe(true);
    });

    it("throws NotFoundError for control methods on an unknown id", async () => {
      const { service } = harness();
      await expect(service.sendEvent("nope", { type: "x" })).rejects.toThrow();
      await expect(service.approve("nope")).rejects.toThrow();
      await expect(service.reject("nope")).rejects.toThrow();
      await expect(service.terminate("nope")).rejects.toThrow();
      await expect(service.pause("nope")).rejects.toThrow();
      await expect(service.resume("nope")).rejects.toThrow();
      await expect(service.restart("nope")).rejects.toThrow();
    });
  });

  describe("status", () => {
    it("syncs a terminal runtime status into the local row", async () => {
      const { runtime, service } = harness();
      await service.run("onboarding", { id: "wf_1" });

      runtime.setStatus("onboarding", "wf_1", { status: "completed", output: { done: true } });

      const info = await service.status("wf_1");
      expect(info.status).toBe("completed");
      expect(info.output).toEqual({ done: true });
      expect(service.get("wf_1")?.status).toBe("completed");
    });

    it("leaves the local row's status alone when the runtime reports a non-terminal status", async () => {
      const { service } = harness();
      await service.run("onboarding", { id: "wf_1" });
      await service.pause("wf_1");

      // The underlying runtime fake still reports "paused" (non-terminal); confirm it is not
      // clobbered back to "running" and the merged view matches the local row.
      const info = await service.status("wf_1");
      expect(info.status).toBe("paused");
    });

    it("throws NotFoundError for an unknown id", async () => {
      const { service } = harness();
      await expect(service.status("nope")).rejects.toThrow();
    });
  });

  describe("get/list/delete", () => {
    it("get() reads the local row only, without touching the runtime", async () => {
      const { service } = harness();
      expect(service.get("nope")).toBeUndefined();
      await service.run("onboarding", { id: "wf_1" });
      expect(service.get("wf_1")?.workflowId).toBe("wf_1");
    });

    it("list() filters by status and workflowName and paginates", async () => {
      const { service } = harness();
      await service.run("a", { id: "wf_1" });
      await service.run("b", { id: "wf_2" });
      await service.run("a", { id: "wf_3" });
      await service.pause("wf_3");

      const all = service.list();
      expect(all.total).toBe(3);
      expect(all.workflows).toHaveLength(3);

      const byName = service.list({ workflowName: "a" });
      expect(byName.total).toBe(2);
      expect(byName.workflows.map((w) => w.workflowId).sort()).toEqual(["wf_1", "wf_3"]);

      const byStatus = service.list({ status: ["paused"] });
      expect(byStatus.workflows.map((w) => w.workflowId)).toEqual(["wf_3"]);

      const paged = service.list({ limit: 1, offset: 1 });
      expect(paged.workflows).toHaveLength(1);
      expect(paged.total).toBe(3);
    });

    it("delete() removes a row and reports whether it existed", async () => {
      const { service } = harness();
      await service.run("onboarding", { id: "wf_1" });
      expect(service.delete("wf_1")).toBe(true);
      expect(service.get("wf_1")).toBeUndefined();
      expect(service.delete("wf_1")).toBe(false);
    });

    it("deleteMany() defaults to settled statuses only", async () => {
      const { service, clock } = harness();
      await service.run("a", { id: "wf_1" });
      await service.run("a", { id: "wf_2" });
      await service.terminate("wf_2");
      clock.advance(10);

      const removed = service.deleteMany();
      expect(removed).toBe(1);
      expect(service.get("wf_1")).toBeDefined();
      expect(service.get("wf_2")).toBeUndefined();
    });

    it("deleteMany() honors an explicit status filter and updatedBefore", async () => {
      const { service, clock } = harness();
      await service.run("a", { id: "wf_1" });
      clock.advance(100);
      await service.run("a", { id: "wf_2" });

      const cutoff = clock.now();
      clock.advance(100);

      const removed = service.deleteMany({ status: ["running"], updatedBefore: cutoff });
      expect(removed).toBe(1);
      expect(service.get("wf_1")).toBeUndefined();
      expect(service.get("wf_2")).toBeDefined();
    });

    it("migrateBinding() rewrites workflowName on matching rows and returns the count", async () => {
      const { service } = harness();
      await service.run("old-name", { id: "wf_1" });
      await service.run("old-name", { id: "wf_2" });
      await service.run("other", { id: "wf_3" });

      const count = service.migrateBinding("old-name", "new-name");
      expect(count).toBe(2);
      expect(service.get("wf_1")?.workflowName).toBe("new-name");
      expect(service.get("wf_2")?.workflowName).toBe("new-name");
      expect(service.get("wf_3")?.workflowName).toBe("other");
    });
  });

  describe("onCallback", () => {
    it("progress: invokes the onProgress hook and bumps updatedAt", async () => {
      const seen: Array<{ wf: WorkflowInfo; payload: unknown }> = [];
      const { service, clock } = harness({
        onProgress: (wf, payload) => {
          seen.push({ wf, payload });
        },
      });
      await service.run("onboarding", { id: "wf_1" });
      const before = service.get("wf_1")!.updatedAt;
      clock.advance(50);

      const result = await service.onCallback({ workflowId: "wf_1", kind: "progress", payload: { pct: 50 } });

      expect(result).toEqual({ recognized: true });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.payload).toEqual({ pct: 50 });
      expect(service.get("wf_1")!.updatedAt).toBeGreaterThan(before);
      expect(service.get("wf_1")!.status).toBe("running");
    });

    it("complete: sets status completed, stores output, and invokes onComplete", async () => {
      const seen: WorkflowInfo[] = [];
      const { service } = harness({
        onComplete: (wf) => {
          seen.push(wf);
        },
      });
      await service.run("onboarding", { id: "wf_1" });

      const result = await service.onCallback({ workflowId: "wf_1", kind: "complete", payload: { total: 3 } });

      expect(result).toEqual({ recognized: true });
      expect(service.get("wf_1")?.status).toBe("completed");
      expect(service.get("wf_1")?.output).toEqual({ total: 3 });
      expect(seen).toHaveLength(1);
    });

    it("error: sets status errored and stores the error message", async () => {
      const { service } = harness();
      await service.run("onboarding", { id: "wf_1" });

      const result = await service.onCallback({ workflowId: "wf_1", kind: "error", payload: "boom" });

      expect(result).toEqual({ recognized: true });
      expect(service.get("wf_1")?.status).toBe("errored");
      expect(service.get("wf_1")?.error).toBe("boom");
    });

    it("unknown workflowId is ignored and reports recognized: false", async () => {
      const seen: unknown[] = [];
      const { service } = harness({
        onProgress: () => {
          seen.push("called");
        },
      });

      const result = await service.onCallback({ workflowId: "nope", kind: "progress", payload: {} });

      expect(result).toEqual({ recognized: false });
      expect(seen).toHaveLength(0);
    });
  });
});
