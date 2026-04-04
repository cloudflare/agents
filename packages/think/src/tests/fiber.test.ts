import { env } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type { ThinkFiberTestAgent } from "./agents/fiber";

async function freshAgent(name: string) {
  return getServerByName(
    env.ThinkFiberTestAgent as unknown as DurableObjectNamespace<ThinkFiberTestAgent>,
    name
  );
}

describe("Think — runFiber", () => {
  it("should run a fiber to completion and return the result", async () => {
    const agent = await freshAgent("rf-basic");
    const result = await agent.runSimpleFiber("hello");
    expect(result).toBe("hello");

    const log = await agent.getExecutionLog();
    expect(log).toContain("executed:hello");
  });

  it("should clean up the fiber row on completion", async () => {
    const agent = await freshAgent("rf-cleanup");
    await agent.runSimpleFiber("done");

    const count = (await agent.getRunningFiberCount()) as unknown as number;
    expect(count).toBe(0);
  });

  it("should support checkpointing via ctx.stash()", async () => {
    const agent = await freshAgent("rf-checkpoint");
    const result = await agent.runCheckpointFiber(["a", "b", "c"]);
    expect(result).toEqual(["a", "b", "c"]);

    const log = await agent.getExecutionLog();
    expect(log).toEqual(["step:a", "step:b", "step:c"]);
  });

  it("should propagate errors from fiber execution", async () => {
    const agent = await freshAgent("rf-error");
    const errorMsg = await agent.runFailingFiber();
    expect(errorMsg).toBe("Intentional fiber error");

    const count = (await agent.getRunningFiberCount()) as unknown as number;
    expect(count).toBe(0);
  });

  it("should support fire-and-forget fibers", async () => {
    const agent = await freshAgent("rf-fire-forget");
    await agent.fireAndForgetFiber("background");
    await agent.waitFor(200);

    const log = await agent.getExecutionLog();
    expect(log).toContain("bg:background");
  });
});

describe("Think — fiber recovery", () => {
  it("should detect and recover an interrupted fiber", async () => {
    const agent = await freshAgent("rf-recovery");
    await agent.insertInterruptedFiber("test-fiber", {
      progress: "halfway"
    });

    await agent.triggerRecovery();

    const recovered = (await agent.getRecoveredFibers()) as Array<
      Record<string, unknown>
    >;
    expect(recovered).toHaveLength(1);
    expect(recovered[0].name).toBe("test-fiber");
    expect(recovered[0].snapshot).toEqual({ progress: "halfway" });
  });

  it("should clean up the fiber row after recovery", async () => {
    const agent = await freshAgent("rf-recovery-cleanup");
    await agent.insertInterruptedFiber("cleanup-fiber");

    await agent.triggerRecovery();

    const count = (await agent.getRunningFiberCount()) as unknown as number;
    expect(count).toBe(0);
  });
});
