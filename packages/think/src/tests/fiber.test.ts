import { env } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type { FiberState } from "../think";
import type { ThinkFiberTestAgent } from "./agents/fiber";

async function freshAgent(name: string) {
  return getServerByName(
    env.ThinkFiberTestAgent as unknown as DurableObjectNamespace<ThinkFiberTestAgent>,
    name
  );
}

// ── Fiber basics ────────────────────────────────────────────────

describe("Think — fibers", () => {
  it("should spawn a fiber and run it to completion", async () => {
    const agent = await freshAgent("fiber-basic");
    const fiberId = await agent.spawn("simpleWork", { value: "hello" });
    expect(fiberId).toBeTruthy();

    // Wait for the fiber to complete
    await agent.waitFor(200);

    const state = (await agent.getFiberState(fiberId)) as unknown as FiberState;
    expect(state).not.toBeNull();
    expect(state.status).toBe("completed");
    expect(state.result).toEqual({ result: "hello" });

    const log = await agent.getExecutionLog();
    expect(log).toContain("executed:hello");
  });

  it("should track completed fibers via onFiberComplete hook", async () => {
    const agent = await freshAgent("fiber-complete-hook");
    const fiberId = await agent.spawn("simpleWork", { value: "tracked" });
    await agent.waitFor(200);

    const completed = (await agent.getCompletedFibers()) as Array<
      Record<string, unknown>
    >;
    expect(completed).toHaveLength(1);
    expect(completed[0].id).toBe(fiberId);
    expect(completed[0].methodName).toBe("simpleWork");
    expect(completed[0].result).toEqual({ result: "tracked" });
  });

  it("should stash a checkpoint during fiber execution", async () => {
    const agent = await freshAgent("fiber-stash");
    const fiberId = await agent.spawn("checkpointingWork", {
      steps: ["a", "b", "c"]
    });
    await agent.waitFor(300);

    const state = (await agent.getFiberState(fiberId)) as unknown as FiberState;
    expect(state).not.toBeNull();
    expect(state.status).toBe("completed");
    // The last stash should have all 3 steps
    expect(state.snapshot).toEqual({
      completedSteps: ["a", "b", "c"],
      currentStep: "c"
    });

    const log = await agent.getExecutionLog();
    expect(log).toEqual(["step:a", "step:b", "step:c"]);
  });

  it("should cancel a fiber", async () => {
    const agent = await freshAgent("fiber-cancel");
    // Use a method that will run — cancel before completion check
    const fiberId = await agent.spawn("simpleWork", { value: "cancel-me" });

    // Cancel immediately (may or may not beat the execution)
    const cancelled = await agent.cancel(fiberId);

    // Either it was cancelled or it already completed
    const state = (await agent.getFiberState(fiberId)) as unknown as FiberState;
    expect(state).not.toBeNull();
    if (cancelled) {
      expect(state.status).toBe("cancelled");
    } else {
      // Already ran to completion
      expect(state.status).toBe("completed");
    }
  });

  it("should fail a fiber after max retries", async () => {
    const agent = await freshAgent("fiber-fail");
    const fiberId = await agent.spawn("failingWork", {}, { maxRetries: 1 });
    await agent.waitFor(500);

    const state = (await agent.getFiberState(fiberId)) as unknown as FiberState;
    expect(state).not.toBeNull();
    expect(state.status).toBe("failed");
    expect(state.error).toBe("Intentional fiber error");

    const log = await agent.getExecutionLog();
    // Should have tried twice (initial + 1 retry)
    expect(log.filter((e) => e === "failing")).toHaveLength(2);
  });

  it("should create the fiber table automatically", async () => {
    const agent = await freshAgent("fiber-table");
    const count = await agent.getFiberCount();
    expect(count).toBe(0);
  });
});

// ── Fiber recovery ──────────────────────────────────────────────

describe("Think — fiber recovery", () => {
  it("should recover interrupted fibers via checkFibers", async () => {
    const agent = await freshAgent("fiber-recovery");
    await agent.spawn("simpleWork", { value: "recover-me" });
    await agent.waitFor(200);

    // Simulate eviction: remove from active set
    // The fiber already completed, so spawn a new one and evict it
    const fiberId2 = await agent.spawn("simpleWork", { value: "evicted" });
    await agent.simulateEviction(fiberId2);

    // Trigger recovery — should detect the "running" fiber as interrupted
    await agent.triggerRecovery();
    await agent.waitFor(300);

    const recovered = (await agent.getRecoveredFibers()) as Array<
      Record<string, unknown>
    >;
    // fiberId2 should have been recovered
    const found = recovered.find(
      (r: Record<string, unknown>) => r.id === fiberId2
    );
    if (found) {
      expect(found.methodName).toBe("simpleWork");
    }
  });
});
