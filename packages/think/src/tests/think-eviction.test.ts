/**
 * Forced Durable Object eviction coverage for Think instance state.
 *
 * Each test explicitly tears down a running actor, routes back through
 * partyserver, and verifies reconstruction from durable state. This does not
 * assert natural idle hibernation or hibernation eligibility.
 */
import type { UIMessage } from "ai";
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type {
  ThinkOnStartHydrationFailureAgent,
  ThinkRecoveryTestAgent,
  ThinkScheduledTasksTestAgent
} from "./agents/think-session";

function recoveryAgent(name: string) {
  return getServerByName(
    env.ThinkRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkRecoveryTestAgent>,
    name
  );
}

function scheduledAgent(name: string) {
  return getServerByName(
    env.ThinkScheduledTasksTestAgent as unknown as DurableObjectNamespace<ThinkScheduledTasksTestAgent>,
    name
  );
}

function hydrationAgent(name: string) {
  return getServerByName(
    env.ThinkOnStartHydrationFailureAgent as unknown as DurableObjectNamespace<ThinkOnStartHydrationFailureAgent>,
    name
  );
}

async function evictAndReacquire<T>(
  stub: T,
  reacquire: () => Promise<T>
): Promise<T> {
  await evictDurableObject(stub as unknown as DurableObjectStub);
  return reacquire();
}

describe("Think recovery after forced Durable Object eviction", () => {
  it("rebuilds the in-memory transcript cache without running a turn", async () => {
    const name = `evict-think-cache-${crypto.randomUUID()}`;
    let agent = await recoveryAgent(name);
    await agent.persistTestMessage({
      id: "user-before-eviction",
      role: "user",
      parts: [{ type: "text", text: "first question" }]
    });
    await agent.persistTestMessage({
      id: "assistant-before-eviction",
      role: "assistant",
      parts: [{ type: "text", text: "first answer" }]
    });

    agent = await evictAndReacquire(agent, () => recoveryAgent(name));

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages.map((message) => message.id)).toEqual([
      "user-before-eviction",
      "assistant-before-eviction"
    ]);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant"
    ]);
    expect(await agent.getTurnCallCount()).toBe(0);
  });

  it("restores declared-task identity and handler configuration", async () => {
    const name = `evict-think-schedule-${crypto.randomUUID()}`;
    let agent = await scheduledAgent(name);
    await agent.setScheduledTasksForTest({
      workflow: {
        schedule: "every 1 minute",
        handler: "record",
        metadata: { workflowName: "daily-digest" }
      }
    });
    await agent.reconcileScheduledTasksForTest();
    const [before] = await agent.listDeclaredScheduledTaskRowsForTest();
    const payload = await agent.getFirstDeclaredPayloadForTest();

    agent = await evictAndReacquire(agent, () => scheduledAgent(name));

    const [after] = await agent.listDeclaredScheduledTaskRowsForTest();
    expect(after).toMatchObject({
      task_id: "workflow",
      schedule_id: before.schedule_id,
      schedule_hash: before.schedule_hash
    });

    const restoredPayload = await agent.getFirstDeclaredPayloadForTest();
    expect(restoredPayload).toEqual(payload);
    await agent.runDeclaredPayloadForTest(restoredPayload);
    expect(await agent.listScheduledTaskHandlerEventsForTest()).toEqual([
      expect.objectContaining({
        taskId: "workflow",
        scheduledFor: payload.scheduledFor,
        occurrenceKey: `workflow:${payload.scheduledFor}`,
        metadataJson: JSON.stringify({ workflowName: "daily-digest" })
      })
    ]);
  });

  it("re-runs degraded startup and remains usable on the fresh instance", async () => {
    const name = `evict-think-degraded-${crypto.randomUUID()}`;
    let agent = await hydrationAgent(name);
    expect(
      (await agent.getOnStartDegradationsForTest()).map(
        (degradation) => degradation.step
      )
    ).toEqual(["transcript-hydration"]);

    const turn = await agent.testChat("are you alive?");
    expect(turn).toMatchObject({ done: true, error: undefined });

    agent = await evictAndReacquire(agent, () => hydrationAgent(name));

    const degradations = await agent.getOnStartDegradationsForTest();
    expect(degradations).toEqual([
      expect.objectContaining({
        step: "transcript-hydration",
        error: expect.stringContaining("SQLITE_NOMEM")
      })
    ]);
    const messages = (await agent.resyncForTest()) as UIMessage[];
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant"
    ]);
  });
});
