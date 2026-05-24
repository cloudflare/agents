import { env } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type { ThinkScheduledTasksTestAgent } from "./agents/think-session";
import type { ThinkSubmissionInspection } from "../think";

type ScheduledTaskConfigForTest = {
  schedule: string;
  timezone?: string;
  prompt: string;
};

type DeclaredScheduledTaskRowForTest = {
  task_id: string;
  schedule_hash: string;
  task_hash: string;
  schedule_id: string | null;
  next_run_at: number | null;
};

type DeclaredScheduledTaskPayloadForTest = {
  taskId: string;
  scheduleHash: string;
  scheduledFor: number;
};

type ThinkScheduledTasksTestStub = {
  setScheduledTasksForTest(
    config: Record<string, ScheduledTaskConfigForTest>
  ): Promise<void>;
  setDefaultTimezoneForTest(timezone?: string): Promise<void>;
  reconcileScheduledTasksForTest(): Promise<void>;
  reconcileScheduledTasksErrorForTest(): Promise<string>;
  validateScheduleForTest(
    schedule: string,
    options?: { timezone?: string; defaultTimezone?: string }
  ): Promise<string | null>;
  nextScheduleTimeForTest(
    schedule: string,
    nowIso: string,
    options?: {
      timezone?: string;
      defaultTimezone?: string;
      previousScheduledFor?: number;
    }
  ): Promise<number>;
  listDeclaredScheduledTaskRowsForTest(): Promise<
    DeclaredScheduledTaskRowForTest[]
  >;
  listSchedulesForTest(): Promise<Array<{ id: string; payload: unknown }>>;
  createUnrelatedScheduleForTest(): Promise<string>;
  getFirstDeclaredPayloadForTest(): Promise<DeclaredScheduledTaskPayloadForTest>;
  runDeclaredPayloadForTest(
    payload: DeclaredScheduledTaskPayloadForTest
  ): Promise<void>;
  runDeclaredPayloadErrorForTest(
    payload: DeclaredScheduledTaskPayloadForTest
  ): Promise<string>;
  listSubmissionsForTest(options?: {
    limit?: number;
  }): Promise<ThinkSubmissionInspection[]>;
  getStoredMessages(): Promise<Array<{ role: string; parts?: unknown[] }>>;
  setChildScheduledTasksForTest(
    name: string,
    config: Record<string, ScheduledTaskConfigForTest>
  ): Promise<void>;
  setChildDefaultTimezoneForTest(
    name: string,
    timezone?: string
  ): Promise<void>;
  reconcileChildScheduledTasksForTest(name: string): Promise<void>;
  listChildDeclaredScheduledTaskRowsForTest(
    name: string
  ): Promise<DeclaredScheduledTaskRowForTest[]>;
  listChildSchedulesForTest(
    name: string
  ): Promise<Array<{ id: string; payload: unknown }>>;
};

async function freshAgent(
  name = crypto.randomUUID()
): Promise<ThinkScheduledTasksTestStub> {
  return getServerByName(
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

describe("Think scheduled tasks", () => {
  it("creates, updates, and removes declared schedule rows without touching unrelated schedules", async () => {
    const agent = await freshAgent();
    await agent.setDefaultTimezoneForTest("Europe/London");
    await agent.setScheduledTasksForTest({
      report: {
        schedule: "every day at 09:00",
        prompt: "Daily report"
      }
    });

    await agent.reconcileScheduledTasksForTest();
    const [initial] = await agent.listDeclaredScheduledTaskRowsForTest();
    expect(initial).toMatchObject({ task_id: "report" });
    expect(initial.schedule_id).toBeTruthy();

    await agent.setScheduledTasksForTest({
      report: {
        schedule: "every day at 09:00",
        prompt: "Updated report prompt"
      }
    });
    await agent.reconcileScheduledTasksForTest();
    const [promptOnly] = await agent.listDeclaredScheduledTaskRowsForTest();
    expect(promptOnly.schedule_id).toBe(initial.schedule_id);
    expect(promptOnly.task_hash).not.toBe(initial.task_hash);

    await agent.setScheduledTasksForTest({
      report: {
        schedule: "every day at 10:00",
        prompt: "Updated report prompt"
      }
    });
    await agent.reconcileScheduledTasksForTest();
    const [scheduleChanged] =
      await agent.listDeclaredScheduledTaskRowsForTest();
    expect(scheduleChanged.schedule_id).not.toBe(initial.schedule_id);
    expect(scheduleChanged.schedule_hash).not.toBe(initial.schedule_hash);

    const unrelatedId = await agent.createUnrelatedScheduleForTest();
    await agent.setScheduledTasksForTest({});
    await agent.reconcileScheduledTasksForTest();

    expect(await agent.listDeclaredScheduledTaskRowsForTest()).toHaveLength(0);
    const schedules = await agent.listSchedulesForTest();
    expect(schedules.map((schedule) => schedule.id)).toContain(unrelatedId);
    expect(schedules.map((schedule) => schedule.id)).not.toContain(
      scheduleChanged.schedule_id
    );
  });

  it("replaces wall-clock schedules when the default timezone changes", async () => {
    const agent = await freshAgent();
    await agent.setDefaultTimezoneForTest("UTC");
    await agent.setScheduledTasksForTest({
      reminder: {
        schedule: "every day at 09:00",
        prompt: "Reminder"
      }
    });
    await agent.reconcileScheduledTasksForTest();
    const [initial] = await agent.listDeclaredScheduledTaskRowsForTest();

    await agent.setDefaultTimezoneForTest("America/New_York");
    await agent.reconcileScheduledTasksForTest();
    const [updated] = await agent.listDeclaredScheduledTaskRowsForTest();

    expect(updated.schedule_hash).not.toBe(initial.schedule_hash);
    expect(updated.schedule_id).not.toBe(initial.schedule_id);
  });

  it("validates runtime DSL and timezone edge cases", async () => {
    const agent = await freshAgent();

    await expect(
      agent.validateScheduleForTest("every day at 25:00", { timezone: "UTC" })
    ).resolves.toMatch(/Unsupported schedule DSL|Invalid schedule time/);
    await expect(
      agent.validateScheduleForTest("every weekday at 09:00")
    ).resolves.toMatch(/requires a timezone/);
    await expect(
      agent.validateScheduleForTest("every 1 minutes")
    ).resolves.toMatch(/singular/);
    await expect(
      agent.validateScheduleForTest("every day at 09:00", {
        timezone: "Not/A_Zone"
      })
    ).resolves.toMatch(/Invalid timezone/);
    await expect(
      agent.validateScheduleForTest("every day at 09:00 in UTC", {
        timezone: "Europe/London"
      })
    ).resolves.toMatch(/does not match/);
    await expect(
      agent.validateScheduleForTest("every 2 hours", { timezone: "UTC" })
    ).resolves.toMatch(/Interval schedules cannot specify a timezone/);
    await expect(
      agent.validateScheduleForTest("every week on monday,monday at 09:00", {
        timezone: "UTC"
      })
    ).resolves.toMatch(/Duplicate schedule day/);
  });

  it("computes late interval and DST wall-clock occurrences", async () => {
    const agent = await freshAgent();

    const lateInterval = await agent.nextScheduleTimeForTest(
      "every 1 hour",
      "2026-01-01T10:30:00.000Z",
      { previousScheduledFor: Date.parse("2026-01-01T08:00:00.000Z") }
    );
    expect(new Date(lateInterval).toISOString()).toBe(
      "2026-01-01T11:00:00.000Z"
    );

    const springForward = await agent.nextScheduleTimeForTest(
      "every day at 01:30",
      "2026-03-28T23:00:00.000Z",
      { timezone: "Europe/London" }
    );
    expect(new Date(springForward).toISOString()).toBe(
      "2026-03-29T01:00:00.000Z"
    );

    const fallBack = await agent.nextScheduleTimeForTest(
      "every day at 01:30",
      "2026-10-24T23:00:00.000Z",
      { timezone: "Europe/London" }
    );
    expect(new Date(fallBack).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  it("submits scheduled work idempotently and schedules the next occurrence", async () => {
    const agent = await freshAgent();
    await agent.setScheduledTasksForTest({
      workout: {
        schedule: "every 1 minute",
        prompt: "Start my workout"
      }
    });
    await agent.reconcileScheduledTasksForTest();
    const payload = await agent.getFirstDeclaredPayloadForTest();

    await agent.runDeclaredPayloadForTest(payload);
    await agent.runDeclaredPayloadForTest(payload);

    const submissions = await waitForSubmissionCount(agent, 1);
    expect(submissions).toHaveLength(1);
    expect(submissions[0].idempotencyKey).toContain(
      `workout:${payload.scheduledFor}`
    );
    expect(submissions[0].metadata).toMatchObject({
      source: "scheduled-task",
      taskId: "workout",
      scheduledFor: payload.scheduledFor,
      schedule: "every 1 minute"
    });

    const messages = await agent.getStoredMessages();
    expect(messages.filter((message) => message.role === "user")).toHaveLength(
      1
    );
    const [row] = await agent.listDeclaredScheduledTaskRowsForTest();
    expect(row.next_run_at).toBeGreaterThan(payload.scheduledFor);
  });

  it("leaves the current occurrence in place when prompt resolution fails", async () => {
    const agent = await freshAgent();
    await agent.setScheduledTasksForTest({
      broken: {
        schedule: "every 1 minute",
        prompt: "__throw__"
      }
    });
    await agent.reconcileScheduledTasksForTest();
    const before = await agent.getFirstDeclaredPayloadForTest();

    await expect(agent.runDeclaredPayloadErrorForTest(before)).resolves.toMatch(
      /scheduled prompt failed/
    );

    const [row] = await agent.listDeclaredScheduledTaskRowsForTest();
    expect(row.next_run_at).toBe(before.scheduledFor);
    expect(await agent.listSubmissionsForTest({ limit: 10 })).toHaveLength(0);
  });

  it("supports declared scheduled tasks in sub-agents", async () => {
    const parent = await freshAgent();
    await parent.setChildDefaultTimezoneForTest("child", "UTC");
    await parent.setChildScheduledTasksForTest("child", {
      childTask: {
        schedule: "every weekday at 09:00",
        prompt: "Child task"
      }
    });

    await parent.reconcileChildScheduledTasksForTest("child");

    const rows =
      await parent.listChildDeclaredScheduledTaskRowsForTest("child");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task_id: "childTask" });
    const childSchedules = await parent.listChildSchedulesForTest("child");
    expect(childSchedules).toHaveLength(1);
  });
});
