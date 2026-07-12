# 05 — Scheduling: DSL, cron subset, scheduler, keep-alive

The original `Agent` multiplexes many logical schedules over the single Durable
Object alarm slot: one-shot (`schedule(Date|delaySeconds, cb, payload)`),
recurring cron (`schedule("0 0 * * *", ...)`), fixed-interval
(`scheduleEvery`), plus the keep-alive heartbeat and internal housekeeping —
all persisted in `cf_agents_schedules` and dispatched from `alarm()`. Think
adds a human-friendly schedule DSL (`"every day at 08:00 in Europe/London"`)
on top. Four modules:

---

## 1. `domain/scheduling/cron.ts` — minimal cron parser

Standard 5-field cron (`minute hour day-of-month month day-of-week`)
supporting: `*`, numbers, lists (`1,15`), ranges (`1-5`), steps (`*/15`,
`1-30/5`), and day-of-week names are NOT required. Semantics: match when
(minute && hour && month) && (dom || dow) — with the classic rule that if both
dom and dow are restricted, either may match; if only one is restricted, it
must match.

```ts
export interface CronSpec { /* parsed fields */ }
export function parseCron(expr: string): CronSpec;             // throws ValidationError
export function nextCronTime(spec: CronSpec, afterMs: number, timezoneOffsetMinutes?: number): number;
```
Compute in UTC (offset support is enough; full IANA zones only needed by the
DSL below, which uses Intl instead). Tests: table-driven next-time cases,
including month/day rollover and `*/n` steps.

---

## 2. `domain/scheduling/dsl.ts` — Think's schedule DSL

### Grammar (complete; reject anything else with a helpful ValidationError)
```
every <n> minutes | every minute
every <n> hours   | every hour
every day at HH:mm [in <IANA timezone>]
every weekday at HH:mm [in <IANA timezone>]
every week on <day[,day...]> at HH:mm [in <IANA timezone>]
```
Day tokens: `sun|sunday|mon|monday|...|sat|saturday` (case-insensitive).
`HH:mm` is 24h, zero-padded or not.

### Semantics
- Interval schedules (`minutes`/`hours`) are timezone-free.
- Wall-clock schedules resolve a timezone with precedence: inline `in <tz>` →
  task-level `timezone` option → agent default timezone. **No timezone
  resolved → ValidationError** at reconcile time.
- `nextOccurrence(parsed, nowMs, tz)`: the next strictly-future occurrence in
  the target timezone, DST-correct (compute via `Intl.DateTimeFormat` parts —
  find the next calendar day matching the weekday set, at HH:mm wall time,
  mapping wall time to the correct UTC instant; on DST-skipped times, roll to
  the next valid instant).
- If an alarm fires late, the caller runs the **intended** occurrence once and
  schedules the next **future** occurrence — no backfill (behavioral note for
  doc 13; the DSL just computes occurrences).

### Proposed interface
```ts
export type ParsedSchedule =
  | { kind: "interval"; everyMs: number }
  | { kind: "wall-clock"; hour: number; minute: number; days: "all" | "weekday" | number[]; inlineTimezone?: string };
export function parseScheduleDsl(raw: string): ParsedSchedule;
export function nextOccurrence(schedule: ParsedSchedule, nowMs: number, timezone?: string): number;
export function describeSchedule(schedule: ParsedSchedule): string; // stable human string, used in hashes
```

### Tests
- Every grammar production; rejection cases (garbage, `every week at`, bad
  time); DST spring-forward (02:30 Europe/London on transition day) rolls
  forward; weekday sets; `nextOccurrence` strictly future.

---

## 3. `domain/scheduling/scheduler.ts` — Scheduler (alarm multiplexer)

### Responsibilities (original behavior)
- Persist logical schedules; keep the physical `AlarmTimer` set to the
  earliest pending `nextRunAt`.
- Kinds: `once` (at a Date or delay-seconds), `cron` (recurring), `interval`
  (every N seconds; recurring).
- On alarm fire: claim all due schedules; for each, dispatch
  `(callback, payload, schedule)` via a host dispatcher; `once` rows are
  deleted after execution; `cron`/`interval` rows compute and persist their
  next run **before** dispatch (so a crash mid-dispatch never loses the next
  occurrence). Then re-arm the timer to the new earliest.
- Retries: a per-schedule retry policy `{ maxAttempts, baseDelayMs }` retries
  the callback (emitting `schedule:retry`) before `schedule:error`.
- Duplicate-callback detection: creating many schedules with the same callback
  emits `schedule:duplicate_warning` (count and kind in payload) — advisory
  only.
- API: `create` returns the schedule descriptor with a generated id (caller
  may supply id → upsert/replace); `get`, `list(criteria)` (by callback, by
  kind, time window), `cancel(id)` (returns bool, re-arms timer).
- Events: `schedule:create|execute|cancel|retry|error`.
- Late alarms: run due schedules once (no per-occurrence backfill for cron —
  compute next from "now", not from the missed slot).

### Proposed interface
```ts
export type ScheduleSpec =
  | { kind: "once"; at: number }
  | { kind: "interval"; everySeconds: number }
  | { kind: "cron"; expression: string };
export interface Schedule<T = unknown> {
  id: string; callback: string; payload: T; spec: ScheduleSpec;
  nextRunAt: number; createdAt: number;
}
export interface Scheduler {
  create<T>(spec: ScheduleSpec, callback: string, payload?: T, options?: { id?: string; retry?: RetryPolicy }): Schedule<T>;
  get(id: string): Schedule | undefined;
  list(criteria?: { callback?: string; kind?: ScheduleSpec["kind"]; dueBefore?: number }): Schedule[];
  cancel(id: string): boolean;
  /** Called by the app layer when the physical alarm fires. */
  onAlarm(): Promise<void>;
  /** Earliest pending time or null (exposed for tests). */
  nextWake(): number | null;
}
export function createScheduler(deps: {
  store: KeyValueStore;        // prefix "sched:"
  alarm: AlarmTimer; clock: Clock; ids: IdSource; bus: EventBus;
  dispatch: (callback: string, payload: unknown, schedule: Schedule) => Promise<void>;
}): Scheduler;
```
Notes:
- The scheduler owns the alarm slot **exclusively**; keep-alive (below) and
  housekeeping (fibers doc 06) register as ordinary schedules/callbacks so the
  single-slot invariant holds in one place.
- Internal callbacks are namespaced `$internal:<name>` and excluded from
  user-facing `list()` by default (`{ includeInternal: true }` opts in).

### Tests
- once/cron/interval next-run computation and re-arm; earliest-wins alarm slot;
  crash-safety ordering (next occurrence persisted before dispatch — simulate
  dispatcher throw and verify recurring schedule survives); cancel re-arms;
  retry/exhaustion events; late-alarm no-backfill; criteria list.

---

## 4. `domain/scheduling/keep-alive.ts` — KeepAlive

### Responsibilities (original behavior)
- Ref-counted heartbeat that prevents DO idle-eviction: while ≥1 ref held, an
  internal interval schedule (default 30s, configurable `keepAliveIntervalMs`)
  keeps the alarm armed; when the last ref is disposed, the heartbeat schedule
  is cancelled.
- Invisible to user `listSchedules()` (internal-namespace callback).
- `keepAliveWhile(fn)` acquire/dispose around an async fn.
- Disposers are idempotent.

### Proposed interface
```ts
export interface KeepAlive {
  acquire(): () => void;
  while<T>(fn: () => Promise<T>): Promise<T>;
  activeRefs(): number;
}
export function createKeepAlive(scheduler: Scheduler, options?: { intervalMs?: number }): KeepAlive;
```

### Tests
- Refcount up/down; idempotent dispose; heartbeat schedule exists only while
  refs held; `while` releases on throw.
