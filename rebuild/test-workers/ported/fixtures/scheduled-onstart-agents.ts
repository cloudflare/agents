import {
  DECLARED_TASK_CALLBACK,
  Think,
  callable,
  hostAgent,
  nextOccurrence,
  parseScheduleDsl,
  type ChatMessage,
  type DeclaredTasks,
  type ModelChunk,
  type ModelClient,
  type Schedule,
  type ScheduledTaskContext
} from "../compat.js";

type ScheduledTaskConfigForTest = {
  schedule: string;
  timezone?: string;
  prompt?: string;
  handler?: "record" | "throw" | "throw-once";
  retry?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number };
  metadata?: Record<string, unknown>;
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

type StoredTaskRow = {
  taskId: string;
  schedule: string;
  timezone?: string;
  metadata?: Record<string, unknown>;
  retry?: { maxAttempts?: number; baseDelayMs?: number };
  kind: "prompt" | "handler";
  scheduleHash: string;
  taskHash: string;
  scheduleId?: string;
  createdAt: number;
  updatedAt: number;
};

type MutableStoredSchedule = Schedule<unknown> & {
  attempts?: number;
};

export type OnStartDegradationForTest = { step: string; error: string };

const scheduledRpcMethodNames = [
  "setScheduledTasksForTest",
  "setDefaultTimezoneForTest",
  "reconcileScheduledTasksForTest",
  "listDeclaredScheduledTaskRowsForTest",
  "listSchedulesForTest"
] as const;

function scheduledModel(text: string): ModelClient {
  return {
    async *stream(): AsyncIterable<ModelChunk> {
      yield { type: "text-delta", text };
      yield { type: "finish", finishReason: "stop" };
    }
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class ThinkScheduledTasksTestAgentImpl extends Think {
  @callable()
  async __dispatchScheduledForTest(
    method: (typeof scheduledRpcMethodNames)[number],
    args: unknown[]
  ): Promise<unknown> {
    if (!scheduledRpcMethodNames.includes(method)) {
      throw new Error(`Unknown scheduled test method: ${method}`);
    }
    const fn = (this as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") {
      throw new Error(`Unknown scheduled test method: ${method}`);
    }
    return fn.apply(this, args) as Promise<unknown>;
  }

  protected override getModel(): ModelClient {
    return scheduledModel("scheduled task response");
  }

  protected override getDefaultTimezone(): string | undefined {
    return this.host.store.get<string>("scheduledTasksDefaultTimezone");
  }

  protected override getScheduledTasks(): DeclaredTasks {
    const config =
      this.host.store.get<Record<string, ScheduledTaskConfigForTest>>(
        "scheduledTasksConfig"
      ) ?? {};
    const tasks: DeclaredTasks = {};
    for (const [taskId, task] of Object.entries(config)) {
      const base = {
        schedule: task.schedule,
        ...(task.timezone !== undefined ? { timezone: task.timezone } : {}),
        ...(task.retry !== undefined
          ? {
              retry: {
                ...(task.retry.maxAttempts !== undefined
                  ? { maxAttempts: task.retry.maxAttempts }
                  : {}),
                ...(task.retry.baseDelayMs !== undefined
                  ? { baseDelayMs: task.retry.baseDelayMs }
                  : {})
              }
            }
          : {}),
        ...(task.metadata !== undefined ? { metadata: task.metadata } : {})
      };

      if (task.handler !== undefined) {
        tasks[taskId] = {
          ...base,
          handler: async (ctx: ScheduledTaskContext) => {
            const events =
              this.host.store.get<ScheduledTaskHandlerEventForTest[]>(
                "scheduledTaskHandlerEvents"
              ) ?? [];
            events.push({
              taskId: ctx.taskId,
              scheduledFor: ctx.scheduledFor,
              scheduledForIso: ctx.scheduledForDate.toISOString(),
              occurrenceKey: ctx.occurrenceKey,
              idempotencyKey: ctx.idempotencyKey,
              schedule: ctx.schedule,
              scheduleKind: ctx.scheduleKind,
              timezone: ctx.timezone ?? null,
              metadataJson:
                ctx.metadata === undefined ? null : JSON.stringify(ctx.metadata)
            });
            this.host.store.put("scheduledTaskHandlerEvents", events);
            if (
              task.handler === "throw" ||
              (task.handler === "throw-once" &&
                events.filter((event) => event.taskId === ctx.taskId).length ===
                  1)
            ) {
              throw new Error("scheduled handler failed");
            }
          }
        };
        continue;
      }

      tasks[taskId] = {
        ...base,
        prompt:
          task.prompt === "__throw__"
            ? () => {
                throw new Error("scheduled prompt failed");
              }
            : (task.prompt ?? "")
      };
    }
    return tasks;
  }

  async setScheduledTasksForTest(
    config: Record<string, ScheduledTaskConfigForTest>
  ): Promise<void> {
    this.host.store.put("scheduledTasksConfig", config);
  }

  async setDefaultTimezoneForTest(timezone?: string): Promise<void> {
    if (timezone === undefined) {
      this.host.store.delete("scheduledTasksDefaultTimezone");
      return;
    }
    this.host.store.put("scheduledTasksDefaultTimezone", timezone);
  }

  async reconcileScheduledTasksForTest(): Promise<void> {
    await this.reconcileScheduledTasks();
  }

  async reconcileScheduledTasksErrorForTest(): Promise<string> {
    try {
      await this.reconcileScheduledTasksForTest();
      return "";
    } catch (err) {
      return errorMessage(err);
    }
  }

  async validateScheduleForTest(
    schedule: string,
    options: { timezone?: string; defaultTimezone?: string } = {}
  ): Promise<string | null> {
    try {
      const parsed = parseScheduleDsl(schedule);
      const timezone =
        parsed.kind === "wall-clock"
          ? (parsed.inlineTimezone ?? options.timezone ?? options.defaultTimezone)
          : undefined;
      if (parsed.kind === "wall-clock" && timezone === undefined) {
        throw new Error("wall-clock schedule requires a timezone");
      }
      if (timezone !== undefined) nextOccurrence(parsed, Date.now(), timezone);
      return null;
    } catch (err) {
      return errorMessage(err);
    }
  }

  async nextScheduleTimeForTest(
    schedule: string,
    nowIso: string,
    options: {
      timezone?: string;
      defaultTimezone?: string;
      previousScheduledFor?: number;
    } = {}
  ): Promise<number> {
    const parsed = parseScheduleDsl(schedule);
    const timezone =
      parsed.kind === "wall-clock"
        ? (parsed.inlineTimezone ?? options.timezone ?? options.defaultTimezone)
        : undefined;
    return nextOccurrence(parsed, Date.parse(nowIso), timezone);
  }

  async listDeclaredScheduledTaskRowsForTest(): Promise<
    DeclaredScheduledTaskRowForTest[]
  > {
    return [...this.host.store.list<StoredTaskRow>({ prefix: "think:task:" })]
      .map(([, row]) => ({
        task_id: row.taskId,
        schedule_hash: row.scheduleHash,
        task_hash: row.taskHash,
        schedule_id: row.scheduleId ?? null,
        next_run_at: row.scheduleId
          ? (this.getScheduleById(row.scheduleId)?.nextRunAt ?? null)
          : null
      }))
      .sort((left, right) => left.task_id.localeCompare(right.task_id));
  }

  async listSchedulesForTest(): Promise<Array<{ id: string; payload: unknown }>> {
    return this.listSchedules({ includeInternal: true }).map((schedule) => ({
      id: schedule.id,
      payload: schedule.payload
    }));
  }

  async listScheduledTaskHandlerEventsForTest(): Promise<
    ScheduledTaskHandlerEventForTest[]
  > {
    return (
      this.host.store.get<ScheduledTaskHandlerEventForTest[]>(
        "scheduledTaskHandlerEvents"
      ) ?? []
    );
  }

  async clearDeclaredScheduleIdForTest(taskId: string): Promise<void> {
    const row = this.host.store.get<StoredTaskRow>(`think:task:${taskId}`);
    if (!row) throw new Error("No declared schedule row");
    if (row.scheduleId) this.cancelSchedule(row.scheduleId);
    const { scheduleId: _scheduleId, ...rest } = row;
    this.host.store.put(`think:task:${taskId}`, rest);
  }

  async createUnrelatedScheduleForTest(): Promise<string> {
    const schedule = this.schedule(
      new Date(Date.now() + 60 * 60_000),
      "noopScheduledTaskForTest",
      { source: "unrelated" }
    );
    return schedule.id;
  }

  async noopScheduledTaskForTest(): Promise<void> {}

  async getFirstDeclaredPayloadForTest(): Promise<DeclaredScheduledTaskPayloadForTest> {
    const [row] = await this.listDeclaredScheduledTaskRowsForTest();
    if (!row?.schedule_id) throw new Error("No declared schedule row");
    const schedule = this.getScheduleById<DeclaredScheduledTaskPayloadForTest>(
      row.schedule_id
    );
    if (!schedule) throw new Error("Declared schedule row has no schedule");
    return schedule.payload;
  }

  async runDeclaredPayloadForTest(
    payload: DeclaredScheduledTaskPayloadForTest
  ): Promise<void> {
    const schedule = this.schedule(
      new Date(Date.now() - 1),
      DECLARED_TASK_CALLBACK,
      payload
    );
    const raw = this.host.store.get<MutableStoredSchedule>(`sched:${schedule.id}`);
    if (raw) {
      this.host.store.put(`sched:${schedule.id}`, {
        ...raw,
        nextRunAt: Date.now() - 1
      });
    }
    await this.onAlarm();
  }

  async runDeclaredPayloadErrorForTest(
    payload: DeclaredScheduledTaskPayloadForTest
  ): Promise<string> {
    try {
      await this.runDeclaredPayloadForTest(payload);
      return "";
    } catch (err) {
      return errorMessage(err);
    }
  }

  async listSubmissionsForTest(options?: {
    limit?: number;
  }): Promise<Array<ReturnType<Think["listSubmissions"]>[number] & { idempotencyKey?: string }>> {
    return this.listSubmissions(options);
  }

  async getStoredMessages(): Promise<ChatMessage[]> {
    return this.getMessages();
  }

  async setChildScheduledTasksForTest(
    name: string,
    config: Record<string, ScheduledTaskConfigForTest>
  ): Promise<void> {
    await this.subAgent("ThinkScheduledTasksTestAgent", name).call(
      "__dispatchScheduledForTest",
      ["setScheduledTasksForTest", [config]]
    );
  }

  async setChildDefaultTimezoneForTest(
    name: string,
    timezone?: string
  ): Promise<void> {
    await this.subAgent("ThinkScheduledTasksTestAgent", name).call(
      "__dispatchScheduledForTest",
      ["setDefaultTimezoneForTest", [timezone]]
    );
  }

  async reconcileChildScheduledTasksForTest(name: string): Promise<void> {
    await this.subAgent("ThinkScheduledTasksTestAgent", name).call(
      "__dispatchScheduledForTest",
      ["reconcileScheduledTasksForTest", []]
    );
  }

  async listChildDeclaredScheduledTaskRowsForTest(
    name: string
  ): Promise<DeclaredScheduledTaskRowForTest[]> {
    return this.subAgent("ThinkScheduledTasksTestAgent", name).call(
      "__dispatchScheduledForTest",
      ["listDeclaredScheduledTaskRowsForTest", []]
    );
  }

  async listChildSchedulesForTest(
    name: string
  ): Promise<Array<{ id: string; payload: unknown }>> {
    return this.subAgent("ThinkScheduledTasksTestAgent", name).call(
      "__dispatchScheduledForTest",
      ["listSchedulesForTest", []]
    );
  }

  async getKeepAliveRefsForTest(): Promise<number> {
    return this.listSchedules({ callback: "$internal:keep-alive", includeInternal: true }).length;
  }

  async runAlarmForTest(): Promise<{
    keepAliveRefs: number;
    scheduledAlarm: number | null;
  }> {
    await this.onAlarm();
    return {
      keepAliveRefs: await this.getKeepAliveRefsForTest(),
      scheduledAlarm: this.host.alarm.get()
    };
  }
}

const ThinkScheduledTasksTestAgentBase = hostAgent(ThinkScheduledTasksTestAgentImpl);

export class ThinkScheduledTasksTestAgent extends ThinkScheduledTasksTestAgentBase {
  setScheduledTasksForTest(
    config: Record<string, ScheduledTaskConfigForTest>
  ): Promise<void> {
    return this.withAgent((agent) => agent.setScheduledTasksForTest(config));
  }

  setDefaultTimezoneForTest(timezone?: string): Promise<void> {
    return this.withAgent((agent) => agent.setDefaultTimezoneForTest(timezone));
  }

  reconcileScheduledTasksForTest(): Promise<void> {
    return this.withAgent((agent) => agent.reconcileScheduledTasksForTest());
  }

  reconcileScheduledTasksErrorForTest(): Promise<string> {
    return this.withAgent((agent) =>
      agent.reconcileScheduledTasksErrorForTest()
    );
  }

  validateScheduleForTest(
    schedule: string,
    options?: { timezone?: string; defaultTimezone?: string }
  ): Promise<string | null> {
    return this.withAgent((agent) =>
      agent.validateScheduleForTest(schedule, options)
    );
  }

  nextScheduleTimeForTest(
    schedule: string,
    nowIso: string,
    options?: {
      timezone?: string;
      defaultTimezone?: string;
      previousScheduledFor?: number;
    }
  ): Promise<number> {
    return this.withAgent((agent) =>
      agent.nextScheduleTimeForTest(schedule, nowIso, options)
    );
  }

  listDeclaredScheduledTaskRowsForTest(): Promise<
    DeclaredScheduledTaskRowForTest[]
  > {
    return this.withAgent((agent) =>
      agent.listDeclaredScheduledTaskRowsForTest()
    );
  }

  listSchedulesForTest(): Promise<Array<{ id: string; payload: unknown }>> {
    return this.withAgent((agent) => agent.listSchedulesForTest());
  }

  listScheduledTaskHandlerEventsForTest(): Promise<
    ScheduledTaskHandlerEventForTest[]
  > {
    return this.withAgent((agent) =>
      agent.listScheduledTaskHandlerEventsForTest()
    );
  }

  clearDeclaredScheduleIdForTest(taskId: string): Promise<void> {
    return this.withAgent((agent) =>
      agent.clearDeclaredScheduleIdForTest(taskId)
    );
  }

  createUnrelatedScheduleForTest(): Promise<string> {
    return this.withAgent((agent) => agent.createUnrelatedScheduleForTest());
  }

  getFirstDeclaredPayloadForTest(): Promise<DeclaredScheduledTaskPayloadForTest> {
    return this.withAgent((agent) => agent.getFirstDeclaredPayloadForTest());
  }

  runDeclaredPayloadForTest(
    payload: DeclaredScheduledTaskPayloadForTest
  ): Promise<void> {
    return this.withAgent((agent) => agent.runDeclaredPayloadForTest(payload));
  }

  runDeclaredPayloadErrorForTest(
    payload: DeclaredScheduledTaskPayloadForTest
  ): Promise<string> {
    return this.withAgent((agent) =>
      agent.runDeclaredPayloadErrorForTest(payload)
    );
  }

  listSubmissionsForTest(options?: {
    limit?: number;
  }): Promise<Array<ReturnType<Think["listSubmissions"]>[number]>> {
    return this.withAgent((agent) => agent.listSubmissionsForTest(options));
  }

  getStoredMessages(): Promise<ChatMessage[]> {
    return this.withAgent((agent) => agent.getStoredMessages());
  }

  setChildScheduledTasksForTest(
    name: string,
    config: Record<string, ScheduledTaskConfigForTest>
  ): Promise<void> {
    return this.withAgent((agent) =>
      agent.setChildScheduledTasksForTest(name, config)
    );
  }

  setChildDefaultTimezoneForTest(
    name: string,
    timezone?: string
  ): Promise<void> {
    return this.withAgent((agent) =>
      agent.setChildDefaultTimezoneForTest(name, timezone)
    );
  }

  reconcileChildScheduledTasksForTest(name: string): Promise<void> {
    return this.withAgent((agent) =>
      agent.reconcileChildScheduledTasksForTest(name)
    );
  }

  listChildDeclaredScheduledTaskRowsForTest(
    name: string
  ): Promise<DeclaredScheduledTaskRowForTest[]> {
    return this.withAgent((agent) =>
      agent.listChildDeclaredScheduledTaskRowsForTest(name)
    );
  }

  listChildSchedulesForTest(
    name: string
  ): Promise<Array<{ id: string; payload: unknown }>> {
    return this.withAgent((agent) => agent.listChildSchedulesForTest(name));
  }

  getKeepAliveRefsForTest(): Promise<number> {
    return this.withAgent((agent) => agent.getKeepAliveRefsForTest());
  }

  runAlarmForTest(): Promise<{
    keepAliveRefs: number;
    scheduledAlarm: number | null;
  }> {
    return this.withAgent((agent) => agent.runAlarmForTest());
  }
}

class ThinkOnStartReconcileFailureAgentImpl extends Think {
  protected override getModel(): ModelClient {
    return scheduledModel("reconcile-failure agent response");
  }

  protected override getScheduledTasks(): DeclaredTasks {
    throw new Error("simulated getScheduledTasks failure");
  }

  async getOnStartDegradationsForTest(): Promise<OnStartDegradationForTest[]> {
    return [];
  }

  async testChat(message: string): Promise<{ done: boolean; error?: string }> {
    const result = await this.chat(message);
    return {
      done: result.outcome === "completed",
      ...(result.error ? { error: result.error.message } : {})
    };
  }

  async getStoredMessages(): Promise<ChatMessage[]> {
    return this.getMessages();
  }
}

const ThinkOnStartReconcileFailureAgentBase = hostAgent(
  ThinkOnStartReconcileFailureAgentImpl
);

export class ThinkOnStartReconcileFailureAgent extends ThinkOnStartReconcileFailureAgentBase {
  getOnStartDegradationsForTest(): Promise<OnStartDegradationForTest[]> {
    return this.withAgent((agent) => agent.getOnStartDegradationsForTest());
  }

  testChat(message: string): Promise<{ done: boolean; error?: string }> {
    return this.withAgent((agent) => agent.testChat(message));
  }

  getStoredMessages(): Promise<ChatMessage[]> {
    return this.withAgent((agent) => agent.getStoredMessages());
  }
}

class ThinkOnStartHydrationFailureAgentImpl extends Think {
  private hydrationReadsFailed = 0;

  protected override getModel(): ModelClient {
    return scheduledModel("hydration-failure agent response");
  }

  protected override async onStart(): Promise<void> {
    await super.onStart();
    this.hydrationReadsFailed++;
    throw new Error("SQL query failed: out of memory: SQLITE_NOMEM");
  }

  async getOnStartDegradationsForTest(): Promise<OnStartDegradationForTest[]> {
    return [];
  }

  async getHydrationReadsFailedForTest(): Promise<number> {
    return this.hydrationReadsFailed;
  }

  async testChat(message: string): Promise<{ done: boolean; error?: string }> {
    const result = await this.chat(message);
    return {
      done: result.outcome === "completed",
      ...(result.error ? { error: result.error.message } : {})
    };
  }

  async getStoredMessages(): Promise<ChatMessage[]> {
    return this.getMessages();
  }

  async resyncForTest(): Promise<ChatMessage[]> {
    return this.getMessages();
  }
}

const ThinkOnStartHydrationFailureAgentBase = hostAgent(
  ThinkOnStartHydrationFailureAgentImpl
);

export class ThinkOnStartHydrationFailureAgent extends ThinkOnStartHydrationFailureAgentBase {
  getOnStartDegradationsForTest(): Promise<OnStartDegradationForTest[]> {
    return this.withAgent((agent) => agent.getOnStartDegradationsForTest());
  }

  getHydrationReadsFailedForTest(): Promise<number> {
    return this.withAgent((agent) => agent.getHydrationReadsFailedForTest());
  }

  testChat(message: string): Promise<{ done: boolean; error?: string }> {
    return this.withAgent((agent) => agent.testChat(message));
  }

  getStoredMessages(): Promise<ChatMessage[]> {
    return this.withAgent((agent) => agent.getStoredMessages());
  }

  resyncForTest(): Promise<ChatMessage[]> {
    return this.withAgent((agent) => agent.resyncForTest());
  }
}
