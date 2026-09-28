import { describe, expect, it } from "vitest";
import {
  DurableToolRuns,
  durableToolRunId,
  type DurableToolInspection,
  type DurableToolOwner,
  type DurableToolRuntime
} from "../../driver";
import { withCapabilityHarness } from "../shared/capability-harness";

type Input = { value: number };
type Result = { value: number };

const foreground: DurableToolOwner = {
  driverId: "pi",
  scope: "main",
  operationId: "operation",
  toolCallId: "tool-call",
  mode: "foreground",
  cancellation: "with-parent"
};

class Runtime implements DurableToolRuntime<Input, Result> {
  readonly states = new Map<string, DurableToolInspection<Result>>();
  readonly starts: string[] = [];
  readonly cancellations: string[] = [];
  completeOnStart = false;

  async inspect(runId: string) {
    return this.states.get(runId) ?? { status: "not-started" as const };
  }

  async start(runId: string, input: Input) {
    this.starts.push(runId);
    this.states.set(
      runId,
      this.completeOnStart
        ? { status: "completed", result: { value: input.value * 2 } }
        : { status: "running", notBefore: Date.now() + 60_000 }
    );
  }

  async cancel(runId: string) {
    this.cancellations.push(runId);
    this.states.set(runId, { status: "cancelled" });
  }
}

describe("DurableToolRuns", () => {
  it("deduplicates a stable run and wakes its owner after completion", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const runtime = new Runtime();
      runtime.completeOnStart = true;
      const wakes: DurableToolOwner[] = [];
      const tools = new DurableToolRuns({
        id: "tools",
        runtime,
        wake: async (owner) => {
          wakes.push(owner);
        }
      });
      const { lifecycle } = install(tools);
      await lifecycle.start();
      const runId = durableToolRunId(foreground);

      expect(await tools.start(runId, foreground, { value: 3 })).toMatchObject({
        accepted: true,
        run: { runId, status: "pending" }
      });
      expect(await tools.start(runId, foreground, { value: 9 })).toMatchObject({
        accepted: false,
        run: { input: { value: 3 } }
      });
      await storage.deleteAlarm();
      const result = tools.wait(runId);

      await tools.onJob({ job: tools.jobs()[0], attempt: 1 });

      expect(await result).toEqual({ value: 6 });
      expect(runtime.starts).toEqual([runId]);
      expect(await tools.get(runId)).toMatchObject({
        status: "completed",
        result: { value: 6 }
      });
      expect(wakes).toEqual([foreground]);
      expect(tools.jobs()).toEqual([]);
      await storage.deleteAlarm();
    });
  });

  it("persists a native wait and reconciles it without restarting", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const runtime = new Runtime();
      const tools = new DurableToolRuns({
        id: "tools",
        runtime,
        wake: async () => {}
      });
      const { lifecycle } = install(tools);
      await lifecycle.start();
      const runId = durableToolRunId(foreground);
      await tools.start(runId, foreground, { value: 4 });
      await storage.deleteAlarm();

      await tools.onJob({ job: tools.jobs()[0], attempt: 1 });
      expect((await tools.get(runId))?.status).toBe("running");
      expect(tools.jobs()[0].time).toBeGreaterThan(Date.now());

      runtime.states.set(runId, {
        status: "completed",
        result: { value: 8 }
      });
      await tools.onJob({ job: tools.jobs()[0], attempt: 1 });

      expect(runtime.starts).toEqual([runId]);
      expect(await tools.result(runId)).toEqual({ value: 8 });
      await storage.deleteAlarm();
    });
  });

  it("cancels attached runs without cancelling detached runs", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const runtime = new Runtime();
      const tools = new DurableToolRuns({
        id: "tools",
        runtime,
        wake: async () => {}
      });
      const { lifecycle } = install(tools);
      await lifecycle.start();
      const attachedId = durableToolRunId(foreground);
      const detachedOwner: DurableToolOwner = {
        ...foreground,
        toolCallId: "background",
        mode: "background",
        cancellation: "detached"
      };
      const detachedId = durableToolRunId(detachedOwner);
      await tools.start(attachedId, foreground, { value: 1 });
      await tools.start(detachedId, detachedOwner, { value: 2 });
      await storage.deleteAlarm();

      expect(await tools.cancelByOperation("operation")).toBe(1);

      expect(runtime.cancellations).toEqual([attachedId]);
      expect(await tools.get(attachedId)).toMatchObject({
        status: "cancelled"
      });
      expect(await tools.get(detachedId)).toMatchObject({ status: "pending" });
      await storage.deleteAlarm();
    });
  });
});
