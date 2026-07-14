import type { AlarmTimer } from "../../../ports/alarms.js";
import type { Clock } from "../../../ports/clock.js";
import type { KeyValueStore } from "../../../ports/storage.js";
import { toErrorValue } from "../../../kernel/errors.js";
import { ValidationError } from "../../../kernel/errors.js";
import type { EventBus } from "../../../kernel/events.js";
import type { IdSource } from "../../../kernel/ids.js";
import { nextCronTime, parseCron } from "./cron.js";

/** Internal callbacks are namespaced under this prefix and hidden from user-facing list(). */
const INTERNAL_PREFIX = "$internal:";

const STORE_PREFIX = "sched:";

const DEFAULT_DUPLICATE_WARNING_THRESHOLD = 3;

export interface RetryPolicy {
  /** Total number of attempts (including the first) before giving up. */
  maxAttempts: number;
  /** Base delay for exponential backoff: attempt N waits baseDelayMs * 2^(N-1). */
  baseDelayMs: number;
}

export type ScheduleSpec =
  | { kind: "once"; at: number }
  | { kind: "interval"; everySeconds: number }
  | { kind: "cron"; expression: string };

export interface Schedule<T = unknown> {
  id: string;
  callback: string;
  payload: T;
  spec: ScheduleSpec;
  nextRunAt: number;
  createdAt: number;
  retry?: RetryPolicy;
}

export interface ListCriteria {
  callback?: string;
  kind?: ScheduleSpec["kind"];
  /** Only schedules whose nextRunAt is strictly before this time. */
  dueBefore?: number;
  /** Include `$internal:`-namespaced callbacks. Defaults to false. */
  includeInternal?: boolean;
}

export interface Scheduler {
  create<T = unknown>(
    spec: ScheduleSpec,
    callback: string,
    payload?: T,
    options?: { id?: string; retry?: RetryPolicy },
  ): Schedule<T>;
  get<T = unknown>(id: string): Schedule<T> | undefined;
  list<T = unknown>(criteria?: ListCriteria): Schedule<T>[];
  cancel(id: string): boolean;
  /** Called by the app layer when the physical alarm fires. */
  onAlarm(): Promise<void>;
  /** Earliest pending nextRunAt across all schedules, or null. Exposed for tests. */
  nextWake(): number | null;
}

/** Bookkeeping fields stored alongside each schedule but never returned to callers. */
interface StoredSchedule<T = unknown> extends Schedule<T> {
  /** Consecutive failed attempts since the last natural (non-retry) firing. */
  attempts: number;
}

export function createScheduler(deps: {
  store: KeyValueStore;
  alarm: AlarmTimer;
  clock: Clock;
  ids: IdSource;
  bus: EventBus;
  dispatch: (callback: string, payload: unknown, schedule: Schedule) => Promise<void>;
  /** Warn once a callback has this many (or more) schedules registered against it. Default 3. */
  duplicateWarningThreshold?: number;
}): Scheduler {
  const duplicateWarningThreshold = deps.duplicateWarningThreshold ?? DEFAULT_DUPLICATE_WARNING_THRESHOLD;

  function keyFor(id: string): string {
    return `${STORE_PREFIX}${id}`;
  }

  function allStored(): StoredSchedule[] {
    return [...deps.store.list<StoredSchedule>({ prefix: STORE_PREFIX }).values()];
  }

  function toPublic<T>(rec: StoredSchedule<T>): Schedule<T> {
    const { attempts: _attempts, ...pub } = rec;
    return pub;
  }

  function computeNextRunAt(spec: ScheduleSpec, nowMs: number): number {
    if (spec.kind === "once") return spec.at;
    if (spec.kind === "interval") return nowMs + spec.everySeconds * 1000;
    return nextCronTime(parseCron(spec.expression), nowMs);
  }

  function validateSpec(spec: ScheduleSpec): void {
    if (spec.kind === "interval" && spec.everySeconds <= 0) {
      throw new ValidationError(`interval schedule requires a positive everySeconds, got ${spec.everySeconds}`);
    }
    if (spec.kind === "cron") {
      parseCron(spec.expression); // throws ValidationError on malformed input
    }
  }

  function nextWake(): number | null {
    const all = allStored();
    if (all.length === 0) return null;
    return Math.min(...all.map((s) => s.nextRunAt));
  }

  function rearm(): void {
    const next = nextWake();
    if (next === null) {
      deps.alarm.clear();
    } else {
      deps.alarm.set(next);
    }
  }

  function create<T = unknown>(
    spec: ScheduleSpec,
    callback: string,
    payload?: T,
    options?: { id?: string; retry?: RetryPolicy },
  ): Schedule<T> {
    validateSpec(spec);

    const now = deps.clock.now();
    const id = options?.id ?? deps.ids.newId("sched");
    const nextRunAt = computeNextRunAt(spec, now);

    const record: StoredSchedule<T> = {
      id,
      callback,
      payload: payload as T,
      spec,
      nextRunAt,
      createdAt: now,
      attempts: 0,
      ...(options?.retry ? { retry: options.retry } : {}),
    };
    deps.store.put(keyFor(id), record);

    deps.bus.emit("schedule:create", {
      id,
      callback,
      kind: spec.kind,
      nextRunAt,
    });

    const siblingsWithCallback = allStored().filter((s) => s.callback === callback && s.id !== id).length;
    const totalWithCallback = siblingsWithCallback + 1;
    if (totalWithCallback >= duplicateWarningThreshold) {
      deps.bus.emit("schedule:duplicate_warning", {
        callback,
        kind: spec.kind,
        count: totalWithCallback,
      });
    }

    rearm();
    return toPublic(record);
  }

  function get<T = unknown>(id: string): Schedule<T> | undefined {
    const rec = deps.store.get<StoredSchedule<T>>(keyFor(id));
    return rec ? toPublic(rec) : undefined;
  }

  function list<T = unknown>(criteria?: ListCriteria): Schedule<T>[] {
    return allStored()
      .filter((s) => {
        if (!criteria?.includeInternal && s.callback.startsWith(INTERNAL_PREFIX)) return false;
        if (criteria?.callback !== undefined && s.callback !== criteria.callback) return false;
        if (criteria?.kind !== undefined && s.spec.kind !== criteria.kind) return false;
        if (criteria?.dueBefore !== undefined && !(s.nextRunAt < criteria.dueBefore)) return false;
        return true;
      })
      .map((s) => toPublic(s as StoredSchedule<T>));
  }

  function cancel(id: string): boolean {
    const existed = deps.store.delete(keyFor(id));
    if (existed) {
      deps.bus.emit("schedule:cancel", { id });
      rearm();
    }
    return existed;
  }

  async function handleFailure(rec: StoredSchedule, now: number, isRecurring: boolean, err: unknown): Promise<void> {
    const policy = rec.retry;
    const attempt = rec.attempts + 1;

    if (policy && attempt < policy.maxAttempts) {
      const delayMs = policy.baseDelayMs * 2 ** (attempt - 1);
      const retryAt = now + delayMs;
      deps.bus.emit("schedule:retry", {
        id: rec.id,
        callback: rec.callback,
        attempt,
        maxAttempts: policy.maxAttempts,
        delayMs,
        error: toErrorValue(err),
      });
      deps.store.put(keyFor(rec.id), { ...rec, attempts: attempt, nextRunAt: retryAt });
      return;
    }

    deps.bus.emit("schedule:error", {
      id: rec.id,
      callback: rec.callback,
      attempts: attempt,
      error: toErrorValue(err),
    });

    if (!isRecurring) {
      deps.store.delete(keyFor(rec.id));
    } else {
      deps.store.put(keyFor(rec.id), {
        ...rec,
        attempts: 0,
        nextRunAt: computeNextRunAt(rec.spec, now),
      });
    }
  }

  async function processDue(rec: StoredSchedule, now: number): Promise<void> {
    const isRecurring = rec.spec.kind !== "once";
    const isRetryFiring = rec.attempts > 0;
    let working = rec;

    if (isRecurring && !isRetryFiring) {
      working = { ...working, nextRunAt: computeNextRunAt(working.spec, now) };
      deps.store.put(keyFor(working.id), working);
    }

    deps.bus.emit("schedule:execute", {
      id: working.id,
      callback: working.callback,
      kind: working.spec.kind,
    });

    try {
      await deps.dispatch(working.callback, working.payload, toPublic(working));
      if (!isRecurring) {
        deps.store.delete(keyFor(working.id));
      } else if (isRetryFiring) {
        deps.store.put(keyFor(working.id), {
          ...working,
          attempts: 0,
          nextRunAt: computeNextRunAt(working.spec, now),
        });
      }
    } catch (err) {
      await handleFailure(working, now, isRecurring, err);
    }
  }

  async function onAlarm(): Promise<void> {
    const now = deps.clock.now();
    const due = allStored()
      .filter((s) => s.nextRunAt <= now)
      .sort((a, b) => a.nextRunAt - b.nextRunAt);

    for (const rec of due) {
      await processDue(rec, now);
    }

    rearm();
  }

  return { create, get, list, cancel, onAlarm, nextWake };
}
