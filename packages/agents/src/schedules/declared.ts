/**
 * Declared schedules: a named set of recurring work defined in code. The
 * Scheduler reconciles its jobs to the declaration, keeps one pending
 * occurrence per name, and re-arms the next occurrence after each run.
 *
 * Each declared name is one Lifecycle job (`declared:<name>`). The job's due
 * time is the occurrence time; its payload carries the parsed timing, so the
 * next occurrence never depends on re-reading the declaration.
 */

import type { LifecycleServices } from "../lifecycle/capability";
import type {
  LifecycleJob,
  LifecycleJobContext,
  LifecycleJobOutcome
} from "../lifecycle/job-queue";
import { resolveRetryConfig, validateRetryOptions } from "../retries";
import type { RetryOptions } from "../retries";
import {
  nextDeclaredScheduleTime,
  parseDeclaredSchedule,
  validateTimezone,
  type DeclaredScheduleExpression,
  type ParsedDeclaredSchedule
} from "./declared-timing";
import type { SchedulerEventType } from "./options";

type MaybePromise<T> = T | Promise<T>;

/**
 * What a declared schedule's `run` receives for one occurrence.
 *
 * @internal
 */
export type DeclaredScheduleContext = {
  /** The declared name. */
  name: string;
  /** The occurrence's intended time, epoch milliseconds. */
  scheduledFor: number;
  scheduledForDate: Date;
  /** `${name}:${scheduledFor}`: unique per occurrence within this object. */
  occurrenceKey: string;
  /** `${idempotencyKeyPrefix}:${occurrenceKey}`: unique across objects. */
  idempotencyKey: string;
  /** The normalized expression, such as `every day at 09:00`. */
  schedule: string;
  scheduleKind: "interval" | "wall-clock";
  /** The resolved timezone of a wall-clock schedule. */
  timezone?: string;
  metadata?: Record<string, unknown>;
};

/**
 * One named, recurring piece of work.
 *
 * @internal
 */
export type DeclaredSchedule = {
  /**
   * When it runs: `every 5 minutes`, `every 2 hours`, `every day at 09:00`,
   * `every weekday at 09:00`, `every week on mon,thu at 18:30`. A wall-clock
   * expression takes a timezone inline (`... in Europe/London`), from
   * `timezone`, or from the `defaultTimezone` option.
   */
  schedule: DeclaredScheduleExpression;
  /** Timezone for a wall-clock expression. Intervals take none. */
  timezone?: string;
  /** Attempts per occurrence. Defaults to the Scheduler's retry policy. */
  retry?: RetryOptions;
  /** Passed through to `run`. */
  metadata?: Record<string, unknown>;
  /** The work. Runs at least once per occurrence. */
  run(context: DeclaredScheduleContext): void | Promise<void>;
};

/**
 * Declared schedules by name. Names use letters, digits, `_` and `-`.
 *
 * @internal
 */
export type DeclaredSchedules = Record<string, DeclaredSchedule>;

/**
 * A declaration, or a function that returns one (read on every run).
 *
 * @internal
 */
export type DeclaredSchedulesSource =
  | DeclaredSchedules
  | (() => MaybePromise<DeclaredSchedules>);

/**
 * Options for {@link Scheduler.declare}.
 *
 * @internal
 */
export type DeclareSchedulesOptions = {
  /**
   * Which declaration this is. Each group reconciles only its own names, so
   * a library and the application can each declare a set on one Scheduler.
   * Letters, digits, `_` and `-`. Default: the application's group.
   */
  group?: string;
  /** Timezone for wall-clock expressions that name none. */
  defaultTimezone?:
    | string
    | (() => MaybePromise<string | undefined>)
    | undefined;
  /**
   * Prefix of each occurrence's `idempotencyKey`. Default:
   * `schedule:<class name>:<object name>`, then `:<group>` outside the
   * application's group.
   */
  idempotencyKeyPrefix?: string;
};

/**
 * One armed declared schedule, as {@link Scheduler.listDeclared} reports it.
 *
 * @internal
 */
export type DeclaredScheduleInfo = {
  name: string;
  /** The group it was declared in, when not the application's. */
  group?: string;
  schedule: string;
  scheduleKind: "interval" | "wall-clock";
  timezone?: string;
  /** The next occurrence, epoch milliseconds. */
  nextRunAt: number;
};

/** @internal Job fn for declared-schedule jobs. */
export const DECLARED_JOB_FN = "declared";

/**
 * Think's declared tasks before they moved here: their callback, table and
 * group. The migration is the one place allowed to know them.
 */
const LEGACY_DECLARED_CALLBACK = "_runDeclaredScheduledTask";
const LEGACY_DECLARED_TABLE = "cf_think_scheduled_tasks";
const LEGACY_DECLARED_GROUP = "think";
/** Next occurrences carried over from the legacy table until `declare()`. */
const LEGACY_NEXT_RUN_KEY = "cf_agents:declared_schedules_legacy_next";

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEFAULT_GROUP = "";

type DeclaredTiming = {
  readonly schedule: ParsedDeclaredSchedule;
  readonly retry?: RetryOptions;
};

type DeclaredJobPayload = {
  readonly declared: DeclaredTiming & {
    readonly name: string;
    readonly group?: string;
    /** The occurrence this job runs. Its due time can move (alarm backoff). */
    readonly scheduledFor: number;
  };
};

type DeclaredJob = LifecycleJob & { payload: DeclaredJobPayload };

type NormalizedDeclared = DeclaredTiming & {
  readonly name: string;
  readonly metadata?: Record<string, unknown>;
  readonly run: DeclaredSchedule["run"];
};

type Declaration = {
  readonly source: DeclaredSchedulesSource;
  readonly options: DeclareSchedulesOptions;
};

/** @internal Whether a Scheduler job is a declared-schedule job. */
export function isDeclaredJob(job: LifecycleJob): job is DeclaredJob {
  const payload = job.payload as Partial<DeclaredJobPayload> | null;
  return (
    job.fn === DECLARED_JOB_FN &&
    typeof payload === "object" &&
    payload !== null &&
    typeof payload.declared?.name === "string" &&
    typeof payload.declared.scheduledFor === "number"
  );
}

function groupOf(job: DeclaredJob): string {
  return job.payload.declared.group ?? DEFAULT_GROUP;
}

function jobId(group: string, name: string): string {
  return group === DEFAULT_GROUP
    ? `declared:${name}`
    : `declared:${group}:${name}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function sameTiming(left: DeclaredTiming, right: DeclaredTiming): boolean {
  return (
    stableStringify({ schedule: left.schedule, retry: left.retry }) ===
    stableStringify({ schedule: right.schedule, retry: right.retry })
  );
}

/** @internal Policy the owning Scheduler supplies. */
export type DeclaredScheduleConfig = {
  readonly lifecycle: () => LifecycleServices;
  readonly retryDefaults: Required<RetryOptions>;
  readonly hungTimeoutSeconds: number;
  readonly onError: (error: unknown) => Promise<void>;
  readonly emit: (
    type: SchedulerEventType,
    payload: Record<string, unknown>
  ) => void;
};

/** @internal The declared-schedule half of a Scheduler. */
export class DeclaredScheduleSet {
  readonly #config: DeclaredScheduleConfig;
  /** The active declaration of each group. */
  readonly #declarations = new Map<string, Declaration>();
  /** Reconciles run one at a time, so an older one cannot undo a newer one. */
  #reconciling: Promise<unknown> = Promise.resolve();
  #warnedRouted = false;

  constructor(config: DeclaredScheduleConfig) {
    this.#config = config;
  }

  get #lifecycle(): LifecycleServices {
    return this.#config.lifecycle();
  }

  /** Read the declaration, make it the group's, then reconcile jobs to it. */
  declare(
    source: DeclaredSchedulesSource,
    options: DeclareSchedulesOptions = {}
  ): Promise<void> {
    const group = options.group ?? DEFAULT_GROUP;
    if (group !== DEFAULT_GROUP && !NAME_PATTERN.test(group)) {
      return Promise.reject(
        new Error(
          `Invalid declared schedule group "${group}"; use letters, numbers, "_" or "-"`
        )
      );
    }
    // Wait for startup outside the chain: a call made before startup must
    // not hold up one made by onStart, which startup itself is waiting on.
    return this.#lifecycle.ready().then(() => {
      const reconcile = this.#reconciling.then(() =>
        this.#reconcile(group, { source, options })
      );
      this.#reconciling = reconcile.catch(() => {});
      return reconcile;
    });
  }

  async #reconcile(group: string, candidate: Declaration): Promise<void> {
    if (this.#lifecycle.routes.source) {
      this.#declarations.set(group, candidate);
      await this.#warnRouted(candidate);
      return;
    }

    let declared: Map<string, NormalizedDeclared>;
    try {
      declared = await this.#read(candidate);
    } catch (error) {
      // Keep the last good declaration running. With none, keep the
      // candidate, so each occurrence reads it again and may succeed.
      if (!this.#declarations.has(group)) {
        this.#declarations.set(group, candidate);
      }
      throw error;
    }
    this.#declarations.set(group, candidate);

    const jobs = this.#lifecycle.jobs;
    const legacyNext =
      group === LEGACY_DECLARED_GROUP
        ? await this.#lifecycle.storage.get<Record<string, number>>(
            LEGACY_NEXT_RUN_KEY
          )
        : undefined;
    const now = new Date();

    for (const entry of declared.values()) {
      const existing = jobs.get(jobId(group, entry.name));
      if (
        existing &&
        isDeclaredJob(existing) &&
        sameTiming(existing.payload.declared, entry)
      ) {
        if (!this.#samePolicy(existing, entry)) {
          await this.#push(
            group,
            entry,
            existing.payload.declared.scheduledFor,
            existing.time
          );
        }
        continue;
      }
      const carried =
        legacyNext && Object.hasOwn(legacyNext, entry.name)
          ? legacyNext[entry.name]
          : undefined;
      await this.#push(
        group,
        entry,
        carried ?? nextDeclaredScheduleTime(entry.schedule, now).getTime()
      );
    }

    for (const job of jobs.list()) {
      if (
        isDeclaredJob(job) &&
        groupOf(job) === group &&
        !declared.has(job.payload.declared.name)
      ) {
        await jobs.cancel(job.id);
      }
    }

    if (legacyNext) await this.#lifecycle.storage.delete(LEGACY_NEXT_RUN_KEY);
    // An unchanged job keeps its time; re-arm so a lost alarm recovers.
    await jobs.rearm();
  }

  /** Armed declared schedules, by next occurrence. */
  list(): DeclaredScheduleInfo[] {
    const infos: DeclaredScheduleInfo[] = [];
    for (const job of this.#lifecycle.jobs.list()) {
      if (!isDeclaredJob(job)) continue;
      const { name, group, schedule, scheduledFor } = job.payload.declared;
      infos.push({
        name,
        ...(group !== undefined && { group }),
        schedule: schedule.normalizedSchedule,
        scheduleKind: schedule.kind,
        ...(schedule.kind === "wall-clock" && { timezone: schedule.timezone }),
        nextRunAt: scheduledFor
      });
    }
    return infos.sort((a, b) => a.nextRunAt - b.nextRunAt);
  }

  /**
   * Run one due occurrence. Arming the next one is a same-id push, which
   * supersedes the drive result, so the outcome returned here is unused.
   */
  async run(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    const { job, attempt } = context;
    if (!isDeclaredJob(job)) return undefined;
    const group = groupOf(job);
    const stored = job.payload.declared;
    const declaration = this.#declarations.get(group);
    // A host that no longer declares this group retires its jobs.
    if (!declaration) return undefined;
    const entry = (await this.#read(declaration)).get(stored.name);
    if (!entry) return undefined;
    if (!sameTiming(stored, entry)) {
      // Declaration changed without a reconcile: re-arm on the new timing
      // rather than run on the old one.
      const next = nextDeclaredScheduleTime(entry.schedule, new Date());
      await this.#push(group, entry, next.getTime());
      return undefined;
    }

    this.#config.emit(attempt === 1 ? "schedule:execute" : "schedule:retry", {
      callback: stored.name,
      id: job.id,
      attempt
    });
    const { scheduledFor } = stored;
    const occurrenceKey = `${stored.name}:${scheduledFor}`;
    const prefix =
      declaration.options.idempotencyKeyPrefix ??
      [
        "schedule",
        this.#lifecycle.className,
        this.#lifecycle.name,
        ...(group === DEFAULT_GROUP ? [] : [group])
      ].join(":");
    const runContext: DeclaredScheduleContext = {
      name: stored.name,
      scheduledFor,
      scheduledForDate: new Date(scheduledFor),
      occurrenceKey,
      idempotencyKey: `${prefix}:${occurrenceKey}`,
      schedule: entry.schedule.normalizedSchedule,
      scheduleKind: entry.schedule.kind,
      ...(entry.schedule.kind === "wall-clock" && {
        timezone: entry.schedule.timezone
      }),
      ...(entry.metadata !== undefined && { metadata: entry.metadata })
    };
    await this.#lifecycle.runInHostContext(() => entry.run(runContext));
    await this.#advance(job);
    return undefined;
  }

  /** A failed occurrence still arms the next one. */
  async runFailed(
    context: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    const { job } = context;
    if (!isDeclaredJob(job)) return undefined;
    const { name } = job.payload.declared;
    console.error(
      `Declared schedule "${name}" failed; its next occurrence is still scheduled`,
      error
    );
    this.#config.emit("schedule:error", {
      callback: name,
      id: job.id,
      error: error instanceof Error ? error.message : String(error),
      attempts: job.retry?.maxAttempts ?? this.#config.retryDefaults.maxAttempts
    });
    try {
      await this.#config.onError(error);
    } catch {
      // Recurrence must survive a failing error handler.
    }
    await this.#advance(job);
    return undefined;
  }

  /**
   * Carry Think's former declared-task storage over: keep each task's next
   * occurrence until Think's first `declare()`, delete the old schedule jobs
   * (the root also holds the ones its facets armed), drop the table.
   */
  async migrateLegacy(): Promise<void> {
    const lifecycle = this.#lifecycle;
    const storage = lifecycle.storage;
    const next: Record<string, number> = Object.create(null);
    for (const job of lifecycle.jobs.list()) {
      if (job.fn !== LEGACY_DECLARED_CALLBACK) continue;
      const timing = job.payload as {
        payload?: { taskId?: unknown; scheduledFor?: unknown };
        owner_path?: string | null;
      } | null;
      const taskId = timing?.payload?.taskId;
      const scheduledFor = timing?.payload?.scheduledFor;
      if (!timing?.owner_path && typeof taskId === "string") {
        // The payload has the exact occurrence; the job time is rounded.
        next[taskId] =
          typeof scheduledFor === "number" ? scheduledFor : job.time;
      }
      await lifecycle.jobs.cancel(job.id);
    }
    const tables = storage.sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        LEGACY_DECLARED_TABLE
      )
      .toArray();
    if (tables.length > 0) {
      const rows = storage.sql
        .exec(`SELECT task_id, next_run_at FROM ${LEGACY_DECLARED_TABLE}`)
        .toArray() as Array<{ task_id: string; next_run_at: number | null }>;
      for (const row of rows) {
        if (typeof row.next_run_at === "number") {
          next[row.task_id] = row.next_run_at;
        }
      }
    }
    if (!lifecycle.routes.source && Object.keys(next).length > 0) {
      await storage.put(LEGACY_NEXT_RUN_KEY, { ...next });
    }
    if (tables.length > 0) {
      storage.sql.exec(`DROP TABLE ${LEGACY_DECLARED_TABLE}`);
    }
  }

  /**
   * Arm the occurrence after the one this job just ran, unless the job
   * changed meanwhile (`run` itself called `declare()`): that newer intent
   * wins.
   */
  async #advance(job: DeclaredJob): Promise<void> {
    const current = this.#lifecycle.jobs.get(job.id);
    if (
      !current ||
      stableStringify(current.payload) !== stableStringify(job.payload)
    ) {
      return;
    }
    const stored = job.payload.declared;
    const next = nextDeclaredScheduleTime(
      stored.schedule,
      new Date(),
      stored.scheduledFor
    ).getTime();
    await this.#lifecycle.jobs.push({
      id: job.id,
      fn: DECLARED_JOB_FN,
      time: next,
      payload: {
        declared: { ...stored, scheduledFor: next }
      } satisfies DeclaredJobPayload,
      retry: job.retry,
      singleflight: true,
      hungTimeoutSeconds: this.#config.hungTimeoutSeconds
    });
  }

  #retryFor(entry: NormalizedDeclared): Required<RetryOptions> {
    return resolveRetryConfig(entry.retry, this.#config.retryDefaults);
  }

  /** Whether a kept job already carries the retry policy in effect now. */
  #samePolicy(job: DeclaredJob, entry: NormalizedDeclared): boolean {
    return (
      stableStringify(job.retry) === stableStringify(this.#retryFor(entry))
    );
  }

  async #push(
    group: string,
    entry: NormalizedDeclared,
    scheduledFor: number,
    time = scheduledFor
  ): Promise<void> {
    await this.#lifecycle.jobs.push({
      id: jobId(group, entry.name),
      fn: DECLARED_JOB_FN,
      time,
      payload: {
        declared: {
          name: entry.name,
          ...(group !== DEFAULT_GROUP && { group }),
          schedule: entry.schedule,
          ...(entry.retry !== undefined && { retry: entry.retry }),
          scheduledFor
        }
      } satisfies DeclaredJobPayload,
      retry: this.#retryFor(entry),
      singleflight: true,
      hungTimeoutSeconds: this.#config.hungTimeoutSeconds
    });
  }

  /** Read and validate a declaration. */
  async #read({
    source,
    options
  }: Declaration): Promise<Map<string, NormalizedDeclared>> {
    const schedules = typeof source === "function" ? await source() : source;
    const rawDefault = options.defaultTimezone;
    const defaultTimezone =
      typeof rawDefault === "function" ? await rawDefault() : rawDefault;
    const resolvedDefault =
      defaultTimezone === undefined
        ? undefined
        : validateTimezone(defaultTimezone);

    const normalized = new Map<string, NormalizedDeclared>();
    for (const [name, entry] of Object.entries(schedules)) {
      if (!NAME_PATTERN.test(name)) {
        throw new Error(
          `Invalid declared schedule name "${name}"; use letters, numbers, "_" or "-"`
        );
      }
      if (typeof entry.run !== "function") {
        throw new Error(`Declared schedule "${name}" has no run function`);
      }
      if (entry.retry) {
        validateRetryOptions(entry.retry, this.#config.retryDefaults);
      }
      normalized.set(name, {
        name,
        schedule: parseDeclaredSchedule(
          entry.schedule,
          entry.timezone,
          resolvedDefault
        ),
        ...(entry.retry !== undefined && { retry: entry.retry }),
        ...(entry.metadata !== undefined && { metadata: entry.metadata }),
        run: entry.run
      });
    }
    return normalized;
  }

  async #warnRouted({ source }: Declaration): Promise<void> {
    if (this.#warnedRouted) return;
    let count: number;
    try {
      count = Object.keys(
        typeof source === "function" ? await source() : source
      ).length;
    } catch {
      return;
    }
    if (count === 0) return;
    this.#warnedRouted = true;
    console.warn(
      `[Scheduler] "${this.#lifecycle.name}" declares ${count} schedule(s) ` +
        `but is a sub-agent: declared schedules run only on a top-level ` +
        `Durable Object, so none are armed here.`
    );
  }
}
