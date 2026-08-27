import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { TestFiberAgent } from "../agents/fibers";
import { seedFiberRun, seedFiberStep } from "../capabilities/fibers";
import type { FiberRunSnapshot, FiberValue } from "../../fibers";

/**
 * Agent-level Fibers tests: the capability installed by Agent's composition
 * root, with subclass definitions declared on the overridable
 * `fiberDefinitions` field. The capability contract itself is covered by
 * ./capability.test.ts on a plain Lifecycle Object; these prove the Agent
 * integration — host-context invocation, shared-alarm coexistence with
 * schedules, and recovery dispatch on a real Agent.
 */

async function waitForState(
  fibers: { get(runId: string): Promise<FiberRunSnapshot<FiberValue> | null> },
  runId: string,
  states: ReadonlyArray<FiberRunSnapshot<FiberValue>["state"]>,
  timeoutMs = 5_000
): Promise<FiberRunSnapshot<FiberValue>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await fibers.get(runId);
    if (snapshot && states.includes(snapshot.state)) return snapshot;
    if (Date.now() > deadline) {
      throw new Error(
        `Run ${runId} stuck in state "${snapshot?.state}" after ${timeoutMs}ms`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Agent fibers integration", () => {
  it("runs subclass fiberDefinitions with journaled steps and host context", async () => {
    const stub = env.TestFiberAgent.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TestFiberAgent) => {
      const receipt = await instance.fibers.run("greet", { name: "matt" });
      const snapshot = await waitForState(instance.fibers, receipt.runId, [
        "completed"
      ]);
      if (snapshot.state !== "completed") throw new Error("unreachable");
      expect(snapshot.result).toEqual({
        greeting: "hello matt",
        hadHostContext: true,
        agentName: instance.name
      });
      expect(instance.stepRuns).toEqual(["greet:compose"]);
    });
  });

  it("rejects reserved internal definition names on the public surface", async () => {
    const stub = env.TestFiberAgent.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TestFiberAgent) => {
      await expect(
        instance.fibers.run(
          "__cf_internal_chat_turn" as "greet",
          undefined as never
        )
      ).rejects.toThrow(/reserved/);
    });
  });

  it("reclaims an interrupted run on the Agent alarm from the journal", async () => {
    const stub = env.TestFiberAgent.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TestFiberAgent, state) => {
      await instance.lifecycle.start();
      seedFiberRun(state.storage, {
        runId: "agent-interrupted",
        definition: "greet",
        input: { name: "revived" },
        state: "running",
        generation: "dead-generation",
        attempt: 1,
        nextAt: Date.now() - 1000
      });
      seedFiberStep(state.storage, {
        runId: "agent-interrupted",
        name: "compose",
        kind: "do",
        state: "completed",
        result: "hello JOURNAL"
      });
      await instance.lifecycle.rearmAlarm();
    });

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: TestFiberAgent) => {
      const snapshot = await waitForState(
        instance.fibers,
        "agent-interrupted",
        ["completed"]
      );
      if (snapshot.state !== "completed") throw new Error("unreachable");
      // The journaled step replayed from storage without re-executing.
      expect(snapshot.result).toEqual({
        greeting: "hello JOURNAL",
        hadHostContext: true,
        agentName: instance.name
      });
      expect(instance.stepRuns).toEqual([]);
    });
  });

  it("shares the physical alarm with Agent schedules", async () => {
    const stub = env.TestFiberAgent.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TestFiberAgent, state) => {
      const schedule = await instance.schedule(120, "noopCallback", undefined);
      expect(await state.storage.getAlarm()).toBe(schedule.time * 1000);

      const receipt = await instance.fibers.run("napper", { ms: 60_000 });
      const parked = await waitForState(instance.fibers, receipt.runId, [
        "waiting"
      ]);
      if (parked.state !== "waiting") throw new Error("unreachable");
      // The sooner fiber deadline wins the shared alarm...
      const deadline = Date.now() + 5_000;
      for (;;) {
        if ((await state.storage.getAlarm()) === parked.wakeAt) break;
        if (Date.now() > deadline) throw new Error("alarm never converged");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      // ...and settling the fiber hands the alarm back to the schedule.
      await instance.fibers.cancel(receipt.runId);
      expect(await state.storage.getAlarm()).toBe(schedule.time * 1000);
      expect(instance.stepRuns).toEqual(["napper:before"]);
    });
  });
});
