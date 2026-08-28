import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { TestTaskAgent } from "../agents/tasks";
import { seedTaskRun, seedTaskStep } from "../capabilities/tasks";
import type { TaskRunSnapshot, TaskValue } from "../../tasks";

/**
 * Agent-level Tasks tests: the capability installed by Agent's composition
 * root, with subclass definitions declared on the overridable
 * `taskDefinitions` field. The capability contract itself is covered by
 * ./capability.test.ts on a plain Lifecycle Object; these prove the Agent
 * integration — host-context invocation, shared-alarm coexistence with
 * schedules, and recovery dispatch on a real Agent.
 */

async function waitForState(
  tasks: { get(runId: string): Promise<TaskRunSnapshot<TaskValue> | null> },
  runId: string,
  states: ReadonlyArray<TaskRunSnapshot<TaskValue>["state"]>,
  timeoutMs = 5_000
): Promise<TaskRunSnapshot<TaskValue>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await tasks.get(runId);
    if (snapshot && states.includes(snapshot.state)) return snapshot;
    if (Date.now() > deadline) {
      throw new Error(
        `Run ${runId} stuck in state "${snapshot?.state}" after ${timeoutMs}ms`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Agent tasks integration", () => {
  it("runs subclass taskDefinitions with journaled steps and host context", async () => {
    const stub = env.TestTaskAgent.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TestTaskAgent) => {
      const receipt = await instance.tasks.run("greet", { name: "matt" });
      const snapshot = await waitForState(instance.tasks, receipt.runId, [
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
    const stub = env.TestTaskAgent.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TestTaskAgent) => {
      await expect(
        instance.tasks.run(
          "__cf_internal_chat_turn" as "greet",
          undefined as never
        )
      ).rejects.toThrow(/reserved/);
    });
  });

  it("reclaims an interrupted run on the Agent alarm from the journal", async () => {
    const stub = env.TestTaskAgent.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TestTaskAgent, state) => {
      await instance.lifecycle.start();
      seedTaskRun(state.storage, {
        runId: "agent-interrupted",
        definition: "greet",
        input: { name: "revived" },
        state: "running",
        generation: "dead-generation",
        attempt: 1,
        nextAt: Date.now() - 1000
      });
      seedTaskStep(state.storage, {
        runId: "agent-interrupted",
        name: "compose",
        kind: "do",
        state: "completed",
        result: "hello JOURNAL"
      });
      await instance.lifecycle.rearmAlarm();
    });

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: TestTaskAgent) => {
      const snapshot = await waitForState(instance.tasks, "agent-interrupted", [
        "completed"
      ]);
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
    const stub = env.TestTaskAgent.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TestTaskAgent, state) => {
      const schedule = await instance.schedule(120, "noopCallback", undefined);
      expect(await state.storage.getAlarm()).toBe(schedule.time * 1000);

      const receipt = await instance.tasks.run("napper", { ms: 60_000 });
      const parked = await waitForState(instance.tasks, receipt.runId, [
        "waiting"
      ]);
      if (parked.state !== "waiting") throw new Error("unreachable");
      // The sooner task deadline wins the shared alarm...
      const deadline = Date.now() + 5_000;
      for (;;) {
        if ((await state.storage.getAlarm()) === parked.wakeAt) break;
        if (Date.now() > deadline) throw new Error("alarm never converged");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      // ...and settling the task hands the alarm back to the schedule.
      await instance.tasks.cancel(receipt.runId);
      expect(await state.storage.getAlarm()).toBe(schedule.time * 1000);
      expect(instance.stepRuns).toEqual(["napper:before"]);
    });
  });
});
