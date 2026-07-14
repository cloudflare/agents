import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryAlarmTimer, type MemoryAlarmTimer } from "../../../adapters/memory/alarms.js";
import { createTestClock, type TestClock } from "../../../adapters/memory/clock.js";
import { createMemoryKeyValueStore } from "../../../adapters/memory/store.js";
import { ValidationError } from "../../../kernel/errors.js";
import { createEventBus, type EventBus, type ObservabilityEvent } from "../../../kernel/events.js";
import { defaultIdSource } from "../../../kernel/ids.js";
import type { ChatMessage } from "../../messages/model.js";
import { createScheduler, type Scheduler } from "../../runtime/scheduling/scheduler.js";
import { createSubmissionService, type SubmissionService } from "../submissions/submissions.js";
import {
  DECLARED_TASK_CALLBACK,
  createScheduledTaskService,
  type DeclaredTasks,
  type ScheduledTaskService,
} from "./tasks.js";

/** No-op delay so retry backoff doesn't slow down tests. */
async function instantDelay(): Promise<void> {}

/** Runner that immediately completes every submission. */
function fakeRunner() {
  const submitted: Array<{ submissionId: string; messages: ChatMessage[] }> = [];
  const runSubmission = vi.fn(async (record: { submissionId: string; messages: ChatMessage[] }) => {
    submitted.push(record);
    return { kind: "completed" as const };
  });
  return { runSubmission, submitted };
}

interface Harness {
  clock: TestClock;
  alarm: MemoryAlarmTimer;
  bus: EventBus;
  events: ObservabilityEvent[];
  scheduler: Scheduler;
  submissions: SubmissionService;
  service: ScheduledTaskService;
  setTasks: (tasks: DeclaredTasks) => void;
  runner: ReturnType<typeof fakeRunner>;
  store: ReturnType<typeof createMemoryKeyValueStore>;
}

function harness(options?: { defaultTimezone?: string; delay?: (ms: number) => Promise<void> }): Harness {
  const clock = createTestClock(0);
  const alarm = createMemoryAlarmTimer(clock);
  const store = createMemoryKeyValueStore();
  const events: ObservabilityEvent[] = [];
  const bus = createEventBus({ agent: "test", name: "agent-1" }, () => clock.now());
  bus.subscribe("*", (e) => events.push(e));

  let service: ScheduledTaskService;
  const scheduler = createScheduler({
    store,
    alarm,
    clock,
    ids: defaultIdSource,
    bus,
    dispatch: async (callback, payload) => {
      if (callback === DECLARED_TASK_CALLBACK) {
        await service.runOccurrence(payload as { taskId: string; scheduledFor: number });
      }
    },
  });
  alarm.onAlarm(() => scheduler.onAlarm());

  const runner = fakeRunner();
  const submissions = createSubmissionService({
    store,
    clock,
    ids: defaultIdSource,
    bus,
    runSubmission: runner.runSubmission,
  });

  let currentTasks: DeclaredTasks = {};
  service = createScheduledTaskService({
    store,
    scheduler,
    submissions,
    clock,
    bus,
    defaultTimezone: () => options?.defaultTimezone,
    declarations: () => currentTasks,
    delay: options?.delay ?? instantDelay,
  });

  return {
    clock,
    alarm,
    bus,
    events,
    scheduler,
    submissions,
    service,
    setTasks: (tasks: DeclaredTasks) => {
      currentTasks = tasks;
    },
    runner,
    store,
  };
}

describe("createScheduledTaskService", () => {
  describe("reconcile — diffing", () => {
    it("inserts a new task, arms a once schedule for nextOccurrence, and lists it", async () => {
      const { service, setTasks } = harness();
      const tasks: DeclaredTasks = { t1: { schedule: "every 10 minutes", handler: vi.fn() } };
      setTasks(tasks);
      await service.reconcile(tasks);

      const listed = service.listTasks();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toEqual({ taskId: "t1", schedule: "every 10 minutes", nextRunAt: 10 * 60_000 });
    });

    it("is idempotent when reconciled repeatedly with unchanged declarations", async () => {
      const { service, scheduler, setTasks } = harness();
      const tasks: DeclaredTasks = { t1: { schedule: "every 10 minutes", handler: vi.fn() } };
      setTasks(tasks);
      await service.reconcile(tasks);
      const firstScheduleId = scheduler.list({ includeInternal: true })[0]!.id;

      await service.reconcile(tasks);
      await service.reconcile(tasks);

      const all = scheduler.list({ includeInternal: true });
      expect(all).toHaveLength(1);
      expect(all[0]!.id).toBe(firstScheduleId);
    });

    it("re-arms when the schedule changes", async () => {
      const { service, scheduler, setTasks } = harness();
      const first: DeclaredTasks = { t1: { schedule: "every 10 minutes", handler: vi.fn() } };
      setTasks(first);
      await service.reconcile(first);
      const oldScheduleId = scheduler.list({ includeInternal: true })[0]!.id;

      const second: DeclaredTasks = { t1: { schedule: "every 30 minutes", handler: vi.fn() } };
      setTasks(second);
      await service.reconcile(second);

      expect(scheduler.get(oldScheduleId)).toBeUndefined();
      const listed = service.listTasks();
      expect(listed[0]!.nextRunAt).toBe(30 * 60_000);
    });

    it("cancels and removes a task no longer in declarations", async () => {
      const { service, scheduler, setTasks } = harness();
      const tasks: DeclaredTasks = { t1: { schedule: "every 10 minutes", handler: vi.fn() } };
      setTasks(tasks);
      await service.reconcile(tasks);
      expect(scheduler.list({ includeInternal: true })).toHaveLength(1);

      setTasks({});
      await service.reconcile({});

      expect(scheduler.list({ includeInternal: true })).toHaveLength(0);
      expect(service.listTasks()).toHaveLength(0);
    });

    it("repairs a pending row that was recorded without a scheduleId", async () => {
      const { service, scheduler, store, setTasks } = harness();
      const tasks: DeclaredTasks = { t1: { schedule: "every 10 minutes", handler: vi.fn() } };
      setTasks(tasks);
      await service.reconcile(tasks);

      // Simulate a crash between the row write and the schedule create: strip
      // the scheduleId while leaving the row's hashes intact.
      const row = store.get<Record<string, unknown>>("task:t1")!;
      expect(row.scheduleId).toBeDefined();
      store.put("task:t1", { ...row, scheduleId: undefined });
      expect(scheduler.list({ includeInternal: true })).toHaveLength(1); // orphaned schedule still there

      await service.reconcile(tasks);

      const listed = service.listTasks();
      expect(listed[0]!.nextRunAt).not.toBeNull();
      const repaired = store.get<Record<string, unknown>>("task:t1")!;
      expect(repaired.scheduleId).toBeDefined();
    });
  });

  describe("reconcile — validation", () => {
    it("throws when a declaration has both prompt and handler", async () => {
      const { service } = harness();
      const tasks = { t1: { schedule: "every minute", prompt: "hi", handler: vi.fn() } } as unknown as DeclaredTasks;
      await expect(service.reconcile(tasks)).rejects.toThrow(ValidationError);
      await expect(service.reconcile(tasks)).rejects.toThrow(/t1/);
    });

    it("throws when a declaration has neither prompt nor handler", async () => {
      const { service } = harness();
      const tasks = { t1: { schedule: "every minute" } } as unknown as DeclaredTasks;
      await expect(service.reconcile(tasks)).rejects.toThrow(ValidationError);
      await expect(service.reconcile(tasks)).rejects.toThrow(/t1/);
    });

    it("throws when a wall-clock schedule has no resolvable timezone", async () => {
      const { service } = harness();
      const tasks: DeclaredTasks = { t1: { schedule: "every day at 09:00", handler: vi.fn() } };
      await expect(service.reconcile(tasks)).rejects.toThrow(ValidationError);
      await expect(service.reconcile(tasks)).rejects.toThrow(/timezone/);
    });

    it("resolves a wall-clock schedule's timezone from the agent default", async () => {
      const { service, setTasks } = harness({ defaultTimezone: "UTC" });
      const tasks: DeclaredTasks = { t1: { schedule: "every day at 09:00", handler: vi.fn() } };
      setTasks(tasks);
      await expect(service.reconcile(tasks)).resolves.toBeUndefined();
    });

    it("throws with the task id in the message for a malformed DSL string", async () => {
      const { service } = harness();
      const tasks: DeclaredTasks = { badTask: { schedule: "whenever I feel like it", handler: vi.fn() } };
      await expect(service.reconcile(tasks)).rejects.toThrow(ValidationError);
      await expect(service.reconcile(tasks)).rejects.toThrow(/badTask/);
    });
  });

  describe("occurrence execution", () => {
    it("prompt task creates a submission with the occurrence idempotency key; duplicate run is deduped", async () => {
      const { service, submissions, setTasks, clock } = harness();
      const tasks: DeclaredTasks = { t1: { schedule: "every 10 minutes", prompt: "do the thing" } };
      setTasks(tasks);
      await service.reconcile(tasks);

      clock.set(10 * 60_000);
      await vi.waitFor(() => expect(submissions.list()).toHaveLength(1));
      const rec = submissions.list()[0]!;
      expect(rec.idempotencyKey).toBe(`task:t1:${10 * 60_000}`);

      // Duplicate delivery of the same occurrence.
      await service.runOccurrence({ taskId: "t1", scheduledFor: 10 * 60_000 });
      expect(submissions.list()).toHaveLength(1);
    });

    it("handler task receives the full ScheduledTaskContext", async () => {
      const handler = vi.fn();
      const { service, setTasks, clock } = harness({ defaultTimezone: "UTC" });
      const tasks: DeclaredTasks = {
        t1: { schedule: "every day at 09:00", handler, metadata: { source: "test" } },
      };
      setTasks(tasks);
      await service.reconcile(tasks);
      const armedAt = service.listTasks()[0]!.nextRunAt!;

      clock.set(armedAt);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

      const ctx = handler.mock.calls[0]![0];
      expect(ctx.taskId).toBe("t1");
      expect(ctx.scheduledFor).toBe(armedAt);
      expect(ctx.scheduledForDate).toEqual(new Date(armedAt));
      expect(ctx.occurrenceKey).toBe(`t1:${armedAt}`);
      expect(ctx.idempotencyKey).toBe(`task:t1:${armedAt}`);
      expect(ctx.schedule).toBe("every day at 09:00");
      expect(ctx.scheduleKind).toBe("wall-clock");
      expect(ctx.timezone).toBe("UTC");
      expect(ctx.metadata).toEqual({ source: "test" });
    });

    it("arms the next occurrence after a successful run", async () => {
      const { service, setTasks, clock } = harness();
      const tasks: DeclaredTasks = { t1: { schedule: "every 10 minutes", handler: vi.fn() } };
      setTasks(tasks);
      await service.reconcile(tasks);

      clock.set(10 * 60_000);
      await vi.waitFor(() => expect(service.listTasks()[0]!.nextRunAt).toBe(20 * 60_000));
    });

    it("arms the next occurrence after retry exhaustion, and emits schedule:error", async () => {
      const { service, setTasks, clock, events } = harness();
      const handler = vi.fn().mockRejectedValue(new Error("boom"));
      const tasks: DeclaredTasks = {
        t1: { schedule: "every 10 minutes", handler, retry: { maxAttempts: 2, baseDelayMs: 5 } },
      };
      setTasks(tasks);
      await service.reconcile(tasks);

      clock.set(10 * 60_000);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(events.some((e) => e.type === "schedule:error")).toBe(true));
      await vi.waitFor(() => expect(service.listTasks()[0]!.nextRunAt).toBe(20 * 60_000));

      const errorEvent = events.find((e) => e.type === "schedule:error")!;
      expect(errorEvent.payload).toMatchObject({ taskId: "t1", attempts: 2 });
    });

    it("late run does not backfill: advancing past several occurrences yields exactly one run", async () => {
      const { service, setTasks, clock } = harness();
      const handler = vi.fn();
      const tasks: DeclaredTasks = { t1: { schedule: "every 10 minutes", handler } };
      setTasks(tasks);
      await service.reconcile(tasks);

      // First occurrence is armed at t=10min. Jump straight to t=35min — past
      // the 10, 20, and 30 minute marks.
      const lateTime = 35 * 60_000;
      clock.set(lateTime);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

      const ctx = handler.mock.calls[0]![0];
      expect(ctx.scheduledFor).toBe(10 * 60_000); // ran the originally intended occurrence

      const nextRunAt = service.listTasks()[0]!.nextRunAt;
      expect(nextRunAt).toBe(lateTime + 10 * 60_000); // computed from "now", not backfilled
    });
  });

  describe("retry policy", () => {
    it("retries a failing handler up to maxAttempts, succeeding on the last attempt", async () => {
      const { service, setTasks, clock, events } = harness();
      let attempt = 0;
      const handler = vi.fn().mockImplementation(async () => {
        attempt += 1;
        if (attempt < 3) throw new Error(`fail ${attempt}`);
      });
      const tasks: DeclaredTasks = {
        t1: { schedule: "every 10 minutes", handler, retry: { maxAttempts: 3, baseDelayMs: 5 } },
      };
      setTasks(tasks);
      await service.reconcile(tasks);

      clock.set(10 * 60_000);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(3));
      expect(events.filter((e) => e.type === "schedule:error")).toHaveLength(0);
    });
  });
});
