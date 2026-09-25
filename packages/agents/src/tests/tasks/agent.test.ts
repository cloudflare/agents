import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TestTaskAgent } from "../agents/tasks";
import type { TestSubAgentParent } from "../agents/sub-agent";
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

  it("restores facet routing before Tasks startup after eviction", async () => {
    const rootName = crypto.randomUUID();
    const rootStub = env.TestSubAgentParent.getByName(rootName);
    await runInDurableObject(rootStub, async (instance: TestSubAgentParent) => {
      await instance.lifecycle.start();
    });

    const childIdentity = crypto.randomUUID();
    const childStub = env.TestTaskAgent.getByName(childIdentity);
    const runId = `facet-task-${crypto.randomUUID()}`;
    const wakeAt = Date.now() + 60 * 60 * 1000;
    const parentPath = [{ className: "TestSubAgentParent", name: rootName }];
    await runInDurableObject(
      childStub,
      async (instance: TestTaskAgent, state) => {
        await instance.lifecycle.start();
        // Persist exactly what facet initialization writes. A direct
        // SQL-backed actor can then be evicted without serializing its stub.
        await Promise.all([
          state.storage.put("cf_agents_is_facet", true),
          state.storage.put("cf_agents_facet_name", "task-child"),
          state.storage.put("cf_agents_parent_path", parentPath)
        ]);
        seedTaskRun(state.storage, {
          runId,
          definition: "napper",
          input: { ms: 60 * 60 * 1000 },
          state: "waiting",
          nextAt: wakeAt
        });
        state.storage.sql.exec(
          "DELETE FROM cf_agents_jobs WHERE id = ?",
          `task:${runId}`
        );
      }
    );

    await evictDurableObject(childStub);
    const freshChild = env.TestTaskAgent.getByName(childIdentity);
    const localWakeIds = await runInDurableObject(
      freshChild,
      async (instance: TestTaskAgent, state) => {
        await instance.lifecycle.start();
        return state.storage.sql
          .exec(
            "SELECT id FROM cf_agents_jobs WHERE capability = 'tasks' ORDER BY id"
          )
          .toArray();
      }
    );

    const rootRows = await runInDurableObject(
      rootStub,
      async (_instance: TestSubAgentParent, state) =>
        state.storage.sql
          .exec(
            `SELECT id, payload FROM cf_agents_jobs
             WHERE capability = 'tasks'
               AND json_extract(payload, '$.runId') = ?`,
            runId
          )
          .toArray()
    );
    const ownerPath = [
      ...parentPath,
      { className: "TestTaskAgent", name: "task-child" }
    ];
    const ownerKey =
      `TestSubAgentParent:${rootName}/` + "TestTaskAgent:task-child";
    expect(localWakeIds).toEqual([]);
    expect(rootRows).toEqual([
      {
        id: `task-routed:${JSON.stringify([ownerKey, runId])}`,
        payload: JSON.stringify({
          runId,
          owner_path: JSON.stringify(ownerPath),
          owner_path_key: ownerKey
        })
      }
    ]);

    await runInDurableObject(freshChild, async (instance: TestTaskAgent) => {
      await instance.tasks.cancel(runId);
    });
  });

  it("runs a due task through the root alarm after its facet is aborted", async () => {
    const rootName = crypto.randomUUID();
    const childName = `task-child-${crypto.randomUUID()}`;
    const runId = `cold-facet-task-${crypto.randomUUID()}`;
    const rootStub = env.TestSubAgentParent.getByName(rootName);
    const ownerKey =
      `TestSubAgentParent:${rootName}/` + `TestTaskAgent:${childName}`;
    const jobId = `task-routed:${JSON.stringify([ownerKey, runId])}`;

    await runInDurableObject(
      rootStub,
      async (instance: TestSubAgentParent, state) => {
        await instance.lifecycle.start();
        const child = await instance.dynamicAgents.get(
          TestTaskAgent,
          childName
        );
        await child.prepareDueNapper(runId);
        expect(
          state.storage.sql
            .exec("SELECT id FROM cf_agents_jobs WHERE id = ?", jobId)
            .toArray()
        ).toEqual([{ id: jobId }]);

        // Leave only durable child state behind, then make the root-owned
        // mirror due. Dispatch must reconstruct facet identity before Tasks
        // startup so completion can cancel this same root job.
        instance.dynamicAgents.abort(TestTaskAgent, childName);
        const past = Date.now() - 1_000;
        state.storage.sql.exec(
          "UPDATE cf_agents_jobs SET time = ? WHERE id = ?",
          past,
          jobId
        );
        await instance.lifecycle.rearmAlarm();
      }
    );

    await runDurableObjectAlarm(rootStub);
    await runInDurableObject(
      rootStub,
      async (instance: TestSubAgentParent, state) => {
        const child = await instance.dynamicAgents.get(
          TestTaskAgent,
          childName
        );
        const deadline = Date.now() + 5_000;
        let observation = await child.inspectTask(runId);
        while (observation.snapshot?.state !== "completed") {
          if (Date.now() > deadline) {
            throw new Error(
              `Cold facet task stuck in ${observation.snapshot?.state}`
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
          observation = await child.inspectTask(runId);
        }

        expect(observation.snapshot.result).toBe("rested");
        expect(observation.stepRuns).toEqual(["napper:after"]);
        const cleanupDeadline = Date.now() + 5_000;
        for (;;) {
          const rows = state.storage.sql
            .exec("SELECT id FROM cf_agents_jobs WHERE id = ?", jobId)
            .toArray();
          if (rows.length === 0) break;
          if (Date.now() > cleanupDeadline) {
            throw new Error(`Root wake ${jobId} was not removed`);
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
    );
  });

  it("deleting a facet cleans its routed wakes but preserves siblings", async () => {
    const rootName = crypto.randomUUID();
    const victimName = `victim-${crypto.randomUUID()}`;
    const siblingName = `sibling-${crypto.randomUUID()}`;
    const rootStub = env.TestSubAgentParent.getByName(rootName);
    const victim = {
      key: `TestSubAgentParent:${rootName}/TestTaskAgent:${victimName}`,
      data: JSON.stringify([
        { className: "TestSubAgentParent", name: rootName },
        { className: "TestTaskAgent", name: victimName }
      ])
    };
    const descendant = {
      key: `${victim.key}/TestTaskAgent:descendant`,
      data: JSON.stringify([
        { className: "TestSubAgentParent", name: rootName },
        { className: "TestTaskAgent", name: victimName },
        { className: "TestTaskAgent", name: "descendant" }
      ])
    };
    const sibling = {
      key: `TestSubAgentParent:${rootName}/TestTaskAgent:${siblingName}`,
      data: JSON.stringify([
        { className: "TestSubAgentParent", name: rootName },
        { className: "TestTaskAgent", name: siblingName }
      ])
    };

    await runInDurableObject(
      rootStub,
      async (instance: TestSubAgentParent, state) => {
        await instance.lifecycle.start();
        await instance.dynamicAgents.get(TestTaskAgent, victimName);
        await instance.dynamicAgents.get(TestTaskAgent, siblingName);
        for (const [source, runId] of [
          [victim, "victim-run"],
          [descendant, "descendant-run"],
          [sibling, "sibling-run"]
        ] as const) {
          await instance.tasks.onRoute({
            source,
            payload: {
              type: "syncWake",
              runId,
              next: Date.now() + 60_000
            }
          });
        }

        await instance.dynamicAgents.delete(TestTaskAgent, victimName);
        const siblingJobId = `task-routed:${JSON.stringify([
          sibling.key,
          "sibling-run"
        ])}`;
        expect(
          state.storage.sql
            .exec(
              `SELECT id FROM cf_agents_jobs
                WHERE capability = 'tasks'
                ORDER BY id`
            )
            .toArray()
        ).toEqual([{ id: siblingJobId }]);

        await instance.dynamicAgents.delete(TestTaskAgent, siblingName);
        expect(
          state.storage.sql
            .exec("SELECT id FROM cf_agents_jobs WHERE capability = 'tasks'")
            .toArray()
        ).toEqual([]);
      }
    );
  });
});
