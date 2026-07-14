import { ValidationError, toErrorValue } from "../../../kernel/errors.js";
import type { EventBus } from "../../../kernel/events.js";
import { stableHash } from "../../../kernel/ids.js";
import type { Clock } from "../../../ports/clock.js";
import { scoped, type KeyValueStore } from "../../../ports/storage.js";
import { userMessage } from "../../messages/model.js";
import { nextOccurrence, parseScheduleDsl, type ParsedSchedule } from "../../runtime/scheduling/dsl.js";
import type { Scheduler } from "../../runtime/scheduling/scheduler.js";
import type { SubmissionService } from "../submissions/submissions.js";

/** Callback name this service registers under in the scheduler's dispatch table. */
export const DECLARED_TASK_CALLBACK = "$internal:declared-task";

export interface ScheduledTaskContext {
  taskId: string;
  scheduledFor: number;
  scheduledForDate: Date;
  /** `${taskId}:${scheduledFor}` */
  occurrenceKey: string;
  /** Stable per occurrence; used as the submission idempotency key. */
  idempotencyKey: string;
  schedule: string;
  scheduleKind: "interval" | "wall-clock";
  timezone?: string;
  metadata?: Record<string, unknown>;
}

interface DeclaredTaskCommon {
  schedule: string;
  timezone?: string;
  metadata?: Record<string, unknown>;
  retry?: { maxAttempts?: number; baseDelayMs?: number };
}

export type DeclaredTask = DeclaredTaskCommon &
  (
    | { prompt: string | (() => string | Promise<string>) }
    | { handler: (ctx: ScheduledTaskContext) => void | Promise<void> }
  );

type PromptDeclaredTask = DeclaredTaskCommon & { prompt: string | (() => string | Promise<string>) };
type HandlerDeclaredTask = DeclaredTaskCommon & { handler: (ctx: ScheduledTaskContext) => void | Promise<void> };

export type DeclaredTasks = Record<string, DeclaredTask>;

export interface ScheduledTaskService {
  reconcile(tasks: DeclaredTasks): Promise<void>;
  /** Wire into the scheduler dispatch table under DECLARED_TASK_CALLBACK. */
  runOccurrence(payload: { taskId: string; scheduledFor: number }): Promise<void>;
  listTasks(): Array<{ taskId: string; schedule: string; nextRunAt: number | null }>;
}

/** Persisted bookkeeping row. The row is written before its schedule is created (crash safety). */
interface TaskRow {
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
}

function loose(decl: DeclaredTask): Record<string, unknown> {
  return decl as unknown as Record<string, unknown>;
}

function classifyKind(taskId: string, decl: DeclaredTask): "prompt" | "handler" {
  const l = loose(decl);
  const hasPrompt = "prompt" in l && l.prompt !== undefined;
  const hasHandler = "handler" in l && l.handler !== undefined;
  if (hasPrompt && hasHandler) {
    throw new ValidationError(`task "${taskId}": declare exactly one of "prompt" or "handler", got both`);
  }
  if (!hasPrompt && !hasHandler) {
    throw new ValidationError(`task "${taskId}": declare exactly one of "prompt" or "handler", got neither`);
  }
  return hasPrompt ? "prompt" : "handler";
}

function resolveTimezone(parsed: ParsedSchedule, declTimezone?: string, defaultTimezone?: string): string | undefined {
  if (parsed.kind !== "wall-clock") return undefined;
  return parsed.inlineTimezone ?? declTimezone ?? defaultTimezone;
}

export function createScheduledTaskService(deps: {
  store: KeyValueStore;
  scheduler: Scheduler;
  submissions: SubmissionService;
  clock: Clock;
  bus: EventBus;
  defaultTimezone?: () => string | undefined;
  /** Live declarations — needed at dispatch time to find prompt/handler fns. */
  declarations: () => DeclaredTasks | Promise<DeclaredTasks>;
  /** Injectable retry backoff delay; defaults to real setTimeout. */
  delay?: (ms: number) => Promise<void>;
}): ScheduledTaskService {
  const kv = scoped(deps.store, "task:");
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  function getRow(taskId: string): TaskRow | undefined {
    return kv.get<TaskRow>(taskId);
  }

  function putRow(row: TaskRow): void {
    kv.put(row.taskId, row);
  }

  function deleteRow(taskId: string): void {
    kv.delete(taskId);
  }

  function allRows(): TaskRow[] {
    return [...kv.list<TaskRow>().values()];
  }

  function parseAndResolve(taskId: string, decl: DeclaredTask): { parsed: ParsedSchedule; timezone?: string } {
    let parsed: ParsedSchedule;
    try {
      parsed = parseScheduleDsl(decl.schedule);
    } catch (err) {
      throw new ValidationError(`task "${taskId}": ${err instanceof Error ? err.message : String(err)}`);
    }
    const timezone = resolveTimezone(parsed, decl.timezone, deps.defaultTimezone?.());
    if (parsed.kind === "wall-clock" && !timezone) {
      throw new ValidationError(
        `task "${taskId}": wall-clock schedule requires a timezone (inline "in <tz>" clause, task-level ` +
          `timezone, or agent default timezone)`,
      );
    }
    return { parsed, timezone };
  }

  function computeHashes(
    decl: DeclaredTask,
    parsed: ParsedSchedule,
    timezone: string | undefined,
    kind: "prompt" | "handler",
  ): { scheduleHash: string; taskHash: string } {
    const scheduleHash = stableHash({ parsed, timezone: timezone ?? null });
    const taskHash = stableHash({ scheduleHash, metadata: decl.metadata ?? null, kind });
    return { scheduleHash, taskHash };
  }

  function armSchedule(taskId: string, parsed: ParsedSchedule, timezone: string | undefined, nowMs: number): string {
    const nextAt = nextOccurrence(parsed, nowMs, timezone);
    const sched = deps.scheduler.create(
      { kind: "once", at: nextAt },
      DECLARED_TASK_CALLBACK,
      { taskId, scheduledFor: nextAt },
    );
    return sched.id;
  }

  async function reconcile(tasks: DeclaredTasks): Promise<void> {
    // Validate + parse every declaration up front so a bad declaration never
    // leaves reconcile() with a partially-applied diff.
    const prepared = new Map<
      string,
      { decl: DeclaredTask; kind: "prompt" | "handler"; parsed: ParsedSchedule; timezone?: string; scheduleHash: string; taskHash: string }
    >();
    for (const [taskId, decl] of Object.entries(tasks)) {
      const kind = classifyKind(taskId, decl);
      const { parsed, timezone } = parseAndResolve(taskId, decl);
      const { scheduleHash, taskHash } = computeHashes(decl, parsed, timezone, kind);
      prepared.set(taskId, { decl, kind, parsed, timezone, scheduleHash, taskHash });
    }

    const now = deps.clock.now();
    const declaredIds = new Set(prepared.keys());

    // Removed from declarations: cancel + delete.
    for (const row of allRows()) {
      if (declaredIds.has(row.taskId)) continue;
      if (row.scheduleId) deps.scheduler.cancel(row.scheduleId);
      deleteRow(row.taskId);
    }

    // Insert / update / repair.
    for (const [taskId, p] of prepared) {
      let row = getRow(taskId);
      if (!row) {
        row = {
          taskId,
          schedule: p.decl.schedule,
          timezone: p.decl.timezone,
          metadata: p.decl.metadata,
          retry: p.decl.retry,
          kind: p.kind,
          scheduleHash: p.scheduleHash,
          taskHash: p.taskHash,
          scheduleId: undefined,
          createdAt: now,
          updatedAt: now,
        };
        putRow(row);
      } else if (row.scheduleHash !== p.scheduleHash) {
        if (row.scheduleId) deps.scheduler.cancel(row.scheduleId);
        row = {
          ...row,
          schedule: p.decl.schedule,
          timezone: p.decl.timezone,
          metadata: p.decl.metadata,
          retry: p.decl.retry,
          kind: p.kind,
          scheduleHash: p.scheduleHash,
          taskHash: p.taskHash,
          scheduleId: undefined,
          updatedAt: now,
        };
        putRow(row);
      } else if (row.taskHash !== p.taskHash) {
        row = {
          ...row,
          schedule: p.decl.schedule,
          timezone: p.decl.timezone,
          metadata: p.decl.metadata,
          retry: p.decl.retry,
          kind: p.kind,
          taskHash: p.taskHash,
          updatedAt: now,
        };
        putRow(row);
      }

      // Repair: no scheduleId yet (crash between row-write and schedule-create),
      // or the schedule it points to no longer exists.
      if (!row.scheduleId || !deps.scheduler.get(row.scheduleId)) {
        const scheduleId = armSchedule(taskId, p.parsed, p.timezone, now);
        row = { ...row, scheduleId, updatedAt: now };
        putRow(row);
      }
    }
  }

  async function runWithRetry(
    taskId: string,
    occurrenceKey: string,
    scheduledFor: number,
    decl: DeclaredTask,
    kind: "prompt" | "handler",
    ctx: ScheduledTaskContext,
    idempotencyKey: string,
  ): Promise<void> {
    const maxAttempts = Math.max(1, decl.retry?.maxAttempts ?? 1);
    const baseDelayMs = decl.retry?.baseDelayMs ?? 0;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (kind === "prompt") {
          const p = (decl as PromptDeclaredTask).prompt;
          const text = typeof p === "function" ? await p() : p;
          await deps.submissions.submit([userMessage(text)], { idempotencyKey, metadata: decl.metadata });
        } else {
          await (decl as HandlerDeclaredTask).handler(ctx);
        }
        return;
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts) {
          await delay(baseDelayMs * 2 ** (attempt - 1));
        }
      }
    }

    deps.bus.emit("schedule:error", {
      taskId,
      occurrenceKey,
      scheduledFor,
      attempts: maxAttempts,
      error: toErrorValue(lastError),
    });
  }

  async function runOccurrence(payload: { taskId: string; scheduledFor: number }): Promise<void> {
    const { taskId, scheduledFor } = payload;
    const row = getRow(taskId);
    if (!row) return; // untracked (removed) task — nothing to run or re-arm.

    // Remove the fired schedule row immediately. The scheduler deletes a
    // `once` row only after dispatch returns, so arming the next occurrence
    // below would otherwise re-trigger the alarm while the stale (past-due)
    // row is still stored — re-entering onAlarm and running this occurrence
    // a second time.
    if (row.scheduleId) deps.scheduler.cancel(row.scheduleId);

    const occurrenceKey = `${taskId}:${scheduledFor}`;
    const idempotencyKey = `task:${occurrenceKey}`;

    const liveTasks = await deps.declarations();
    const decl = liveTasks[taskId];

    if (decl) {
      try {
        const kind = classifyKind(taskId, decl);
        const { parsed, timezone } = parseAndResolve(taskId, decl);
        const ctx: ScheduledTaskContext = {
          taskId,
          scheduledFor,
          scheduledForDate: new Date(scheduledFor),
          occurrenceKey,
          idempotencyKey,
          schedule: decl.schedule,
          scheduleKind: parsed.kind,
          timezone,
          metadata: decl.metadata,
        };
        await runWithRetry(taskId, occurrenceKey, scheduledFor, decl, kind, ctx, idempotencyKey);
      } catch (err) {
        // Live declaration itself is invalid at execution time (drifted since
        // last reconcile). Surface it the same way a retry-exhausted run does.
        deps.bus.emit("schedule:error", {
          taskId,
          occurrenceKey,
          scheduledFor,
          attempts: 1,
          error: toErrorValue(err),
        });
      }
    }

    // Arm the next occurrence from the row's last-known-valid schedule,
    // regardless of execution outcome: failures never block future runs, and
    // a late run is never backfilled (computed strictly-future from "now").
    const parsedForArm = parseScheduleDsl(row.schedule);
    const scheduleId = armSchedule(taskId, parsedForArm, row.timezone, deps.clock.now());
    putRow({ ...row, scheduleId, updatedAt: deps.clock.now() });
  }

  function listTasks(): Array<{ taskId: string; schedule: string; nextRunAt: number | null }> {
    return allRows().map((row) => ({
      taskId: row.taskId,
      schedule: row.schedule,
      nextRunAt: row.scheduleId ? (deps.scheduler.get(row.scheduleId)?.nextRunAt ?? null) : null,
    }));
  }

  return { reconcile, runOccurrence, listTasks };
}
