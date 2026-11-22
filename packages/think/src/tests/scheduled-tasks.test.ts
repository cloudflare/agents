import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { DeclaredScheduleInfo } from "agents/internal";
import { describe, expect, it } from "vitest";
import type { ThinkScheduledTasksTestAgent } from "./agents/think-session";
import type { ThinkSubmissionInspection } from "../think";

type ScheduledTaskConfigForTest = {
  schedule: string;
  timezone?: string;
  prompt?: string;
  handler?: "record" | "throw" | "throw-once";
  retry?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number };
  metadata?: Record<string, unknown>;
};

type ScheduledTaskHandlerEventForTest = {
  taskId: string;
  scheduledFor: number;
  scheduledForIso: string;
  occurrenceKey: string;
  idempotencyKey: string;
  schedule: string;
  scheduleKind: string;
  timezone: string | null;
  metadataJson: string | null;
};

type ThinkScheduledTasksTestStub = {
  setScheduledTasksForTest(
    config: Record<string, ScheduledTaskConfigForTest>
  ): Promise<void>;
  setDefaultTimezoneForTest(timezone?: string): Promise<void>;
  reconcileScheduledTasksForTest(): Promise<void>;
  reconcileScheduledTasksErrorForTest(): Promise<string>;
  listDeclaredForTest(): Promise<DeclaredScheduleInfo[]>;
  runDeclaredNowForTest(taskId: string, scheduledFor?: number): Promise<number>;
  declareAppScheduleForTest(): Promise<void>;
  listSchedulesForTest(): Promise<Array<{ id: string; payload: unknown }>>;
  listScheduledTaskHandlerEventsForTest(): Promise<
    ScheduledTaskHandlerEventForTest[]
  >;
  createUnrelatedScheduleForTest(): Promise<string>;
  listSubmissionsForTest(options?: {
    limit?: number;
  }): Promise<ThinkSubmissionInspection[]>;
  getStoredMessages(): Promise<Array<{ role: string; parts?: unknown[] }>>;
  setChildScheduledTasksForTest(
    name: string,
    config: Record<string, ScheduledTaskConfigForTest>
  ): Promise<void>;
  reconcileChildScheduledTasksWarningsForTest(name: string): Promise<string[]>;
  listChildDeclaredForTest(name: string): Promise<DeclaredScheduleInfo[]>;
  listChildSchedulesForTest(
    name: string
  ): Promise<Array<{ id: string; payload: unknown }>>;
  getKeepAliveRefsForTest(): Promise<number>;
  runAlarmForTest(): Promise<{
    keepAliveRefs: number;
    scheduledAlarm: number | null;
  }>;
};

async function freshAgent(
  name = crypto.randomUUID()
): Promise<ThinkScheduledTasksTestStub> {
  return getAgentByName(
    env.ThinkScheduledTasksTestAgent as unknown as DurableObjectNamespace<ThinkScheduledTasksTestAgent>,
    name
  ) as unknown as Promise<ThinkScheduledTasksTestStub>;
}

async function waitForSubmissionCount(
  agent: ThinkScheduledTasksTestStub,
  count: number
): Promise<ThinkSubmissionInspection[]> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const submissions = await agent.listSubmissionsForTest({ limit: 10 });
    if (submissions.length >= count) return submissions;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return agent.listSubmissionsForTest({ limit: 10 });
}

async function nextRunAt(
  agent: ThinkScheduledTasksTestStub,
  taskId: string
): Promise<number | undefined> {
  const declared = await agent.listDeclaredForTest();
  return declared.find((info) => info.name === taskId)?.nextRunAt;
}

describe("Think scheduled tasks", () => {
  it("reconciles declared tasks without touching unrelated schedules", async () => {
    const agent = await freshAgent();
    await agent.setDefaultTimezoneForTest("Europe/London");
    await agent.setScheduledTasksForTest({
      report: { schedule: "every day at 09:00", prompt: "Daily report" }
    });
    await agent.reconcileScheduledTasksForTest();
    const [initial] = await agent.listDeclaredForTest();
    expect(initial).toMatchObject({
      name: "report",
      schedule: "every day at 09:00",
      timezone: "Europe/London"
    });

    // A prompt change keeps the pending occurrence.
    await agent.setScheduledTasksForTest({
      report: { schedule: "every day at 09:00", prompt: "Updated prompt" }
    });
    await agent.reconcileScheduledTasksForTest();
    expect(await nextRunAt(agent, "report")).toBe(initial.nextRunAt);

    await agent.setScheduledTasksForTest({
      report: { schedule: "every day at 10:00", prompt: "Updated prompt" }
    });
    await agent.reconcileScheduledTasksForTest();
    expect(await nextRunAt(agent, "report")).not.toBe(initial.nextRunAt);

    const unrelatedId = await agent.createUnrelatedScheduleForTest();
    await agent.setScheduledTasksForTest({});
    await agent.reconcileScheduledTasksForTest();

    expect(await agent.listDeclaredForTest()).toEqual([]);
    expect(
      (await agent.listSchedulesForTest()).map((schedule) => schedule.id)
    ).toEqual([unrelatedId]);
  });

  it("leaves the application's own declared schedules alone", async () => {
    const agent = await freshAgent();
    await agent.declareAppScheduleForTest();
    await agent.setScheduledTasksForTest({
      digest: { schedule: "every 1 minute", prompt: "Digest" }
    });
    await agent.reconcileScheduledTasksForTest();
    await agent.setScheduledTasksForTest({});
    await agent.reconcileScheduledTasksForTest();

    expect(await agent.listDeclaredForTest()).toEqual([
      expect.objectContaining({ name: "cleanup", schedule: "every 1 hour" })
    ]);
    expect((await agent.listDeclaredForTest())[0].group).toBeUndefined();
  });

  it("submits scheduled prompts idempotently and arms the next occurrence", async () => {
    const agent = await freshAgent();
    await agent.setScheduledTasksForTest({
      workout: { schedule: "every 1 minute", prompt: "Start my workout" }
    });
    await agent.reconcileScheduledTasksForTest();

    const scheduledFor = await agent.runDeclaredNowForTest("workout");
    // The same occurrence delivered again (at-least-once) is deduplicated.
    await agent.runDeclaredNowForTest("workout", scheduledFor);

    const submissions = await waitForSubmissionCount(agent, 1);
    expect(submissions).toHaveLength(1);
    expect(submissions[0].idempotencyKey).toMatch(
      new RegExp(`^think-schedule:[0-9a-f]+:workout:${scheduledFor}$`)
    );
    expect(submissions[0].metadata).toMatchObject({
      source: "scheduled-task",
      taskId: "workout",
      scheduledFor,
      schedule: "every 1 minute"
    });
    const messages = await agent.getStoredMessages();
    expect(messages.filter((message) => message.role === "user")).toHaveLength(
      1
    );
    expect(await nextRunAt(agent, "workout")).toBeGreaterThan(scheduledFor);
  });

  it("arms the next occurrence when prompt resolution fails", async () => {
    const agent = await freshAgent();
    await agent.setScheduledTasksForTest({
      broken: {
        schedule: "every 1 minute",
        prompt: "__throw__",
        retry: { maxAttempts: 1 }
      }
    });
    await agent.reconcileScheduledTasksForTest();

    const scheduledFor = await agent.runDeclaredNowForTest("broken");

    expect(await nextRunAt(agent, "broken")).toBeGreaterThan(scheduledFor);
    expect(await agent.listSubmissionsForTest({ limit: 10 })).toHaveLength(0);
  });

  it("runs scheduled task handlers with stable occurrence context", async () => {
    const agent = await freshAgent();
    await agent.setScheduledTasksForTest({
      workflow: {
        schedule: "every 1 minute",
        handler: "record",
        metadata: { workflowName: "daily-digest" }
      }
    });
    await agent.reconcileScheduledTasksForTest();

    const scheduledFor = await agent.runDeclaredNowForTest("workflow");

    const events = await agent.listScheduledTaskHandlerEventsForTest();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      taskId: "workflow",
      scheduledFor,
      scheduledForIso: new Date(scheduledFor).toISOString(),
      occurrenceKey: `workflow:${scheduledFor}`,
      schedule: "every 1 minute",
      scheduleKind: "interval",
      timezone: null,
      metadataJson: JSON.stringify({ workflowName: "daily-digest" })
    });
    expect(events[0].idempotencyKey).toMatch(
      new RegExp(`^think-schedule:[0-9a-f]+:workflow:${scheduledFor}$`)
    );
    expect(await agent.listSubmissionsForTest({ limit: 10 })).toHaveLength(0);
    expect(await nextRunAt(agent, "workflow")).toBeGreaterThan(scheduledFor);
  });

  it("retries scheduled task handlers before recording failure", async () => {
    const agent = await freshAgent();
    await agent.setScheduledTasksForTest({
      workflow: {
        schedule: "every day at 09:00",
        timezone: "UTC",
        handler: "throw-once",
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 }
      }
    });
    await agent.reconcileScheduledTasksForTest();

    await agent.runDeclaredNowForTest("workflow");

    const events = await agent.listScheduledTaskHandlerEventsForTest();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      scheduleKind: "wall-clock",
      timezone: "UTC"
    });
  });

  it("arms the next occurrence when scheduled task handlers keep failing", async () => {
    const agent = await freshAgent();
    await agent.setScheduledTasksForTest({
      workflow: {
        schedule: "every 1 minute",
        handler: "throw",
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 }
      }
    });
    await agent.reconcileScheduledTasksForTest();

    const scheduledFor = await agent.runDeclaredNowForTest("workflow");

    expect(await agent.listScheduledTaskHandlerEventsForTest()).toHaveLength(3);
    expect(await nextRunAt(agent, "workflow")).toBeGreaterThan(scheduledFor);
  });

  it("arms declared tasks on the root only, and says so on a sub-agent (#1877)", async () => {
    const parent = await freshAgent();
    const tasks = {
      digest: { schedule: "every 1 minute", prompt: "Daily digest" }
    };
    await parent.setScheduledTasksForTest(tasks);
    await parent.setChildScheduledTasksForTest("alpha", tasks);

    await parent.reconcileScheduledTasksForTest();
    const warnings =
      await parent.reconcileChildScheduledTasksWarningsForTest("alpha");

    expect(await parent.listDeclaredForTest()).toHaveLength(1);
    expect(await parent.listChildDeclaredForTest("alpha")).toEqual([]);
    expect(await parent.listChildSchedulesForTest("alpha")).toEqual([]);
    expect(warnings.join("\n")).toMatch(/declared schedules run only on/);
  });

  it("does not arm a keepAlive heartbeat on alarm() when no workflow notifications are pending (#1703)", async () => {
    const agent = await freshAgent();

    // An agent that never uses workflow notifications must not turn alarm()
    // into a self-perpetuating 30s heartbeat. With no pending notifications
    // and no other scheduled work, the drain must be a no-op: keepAlive refs
    // stay at 0 and no near-future alarm is left behind.
    const before = await agent.getKeepAliveRefsForTest();
    expect(before).toBe(0);

    const { keepAliveRefs, scheduledAlarm } = await agent.runAlarmForTest();

    expect(keepAliveRefs).toBe(0);
    expect(scheduledAlarm).toBeNull();
  });
});
