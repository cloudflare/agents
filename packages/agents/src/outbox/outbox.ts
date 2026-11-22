/**
 * Deliver until acknowledged. The Outbox stores values addressed to named
 * sinks, one row per `(sink, key)`, and retries each with backoff until its
 * sink returns or the retry policy gives up. Each pending delivery is one
 * Lifecycle job due at its next attempt; the rows are the source of truth
 * and the jobs only wake them.
 */

import { nanoid } from "nanoid";
import {
  LifecycleCapability,
  type LifecycleRouteAddress,
  type LifecycleRouteContext
} from "../lifecycle/capability";
import type { MemoryLimitContext } from "../lifecycle/capability-runner";
import type {
  LifecycleJobContext,
  LifecycleJobOutcome
} from "../lifecycle/job-queue";
import {
  isDurableObjectMemoryLimitReset,
  isDurableObjectResetError,
  isPlatformFailure
} from "../retries";
import { SqlError } from "../sql-error";
import type {
  OutboxDelivery,
  OutboxDeliveryContext,
  OutboxDeliveryStatus,
  OutboxEventType,
  OutboxListOptions,
  OutboxOptions,
  OutboxPayload,
  OutboxRetryPolicy,
  OutboxSendOptions,
  OutboxSink,
  OutboxSinks
} from "./types";

/** Largest JSON value one delivery holds. SQLite rows stop at 2 MB. */
export const MAX_OUTBOX_PAYLOAD_BYTES = 1_000_000;

const JOB_PREFIX = "outbox:";
const JOB_FN = "deliver";
/** The Outbox applies its own backoff; the queue never retries in-process. */
const JOB_RETRY = { maxAttempts: 1 } as const;
/** How long one dispatch holds the alarm loop before running on detached. */
const DISPATCH_BUDGET_MS = 5_000;
/**
 * The wake re-armed behind an attempt that is still running. If the isolate
 * dies mid-attempt, this is when the delivery runs again.
 */
const ATTEMPT_LEASE_MS = 5 * 60 * 1000;
/** Failed deliveries older than this are purged at startup. */
const FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_RETRY: Required<OutboxRetryPolicy> = {
  baseDelayMs: 2_000,
  maxDelayMs: 10 * 60 * 1000,
  maxAttempts: Number.POSITIVE_INFINITY,
  giveUpAfterMs: 12 * 60 * 60 * 1000
};

const encoder = new TextEncoder();

type OutboxRow = {
  id: string;
  sink: string;
  key: string;
  payload: string | null;
  idempotency_key: string;
  status: OutboxDeliveryStatus;
  retry_options: string | null;
  attempts: number;
  first_attempt_at: number | null;
  next_at: number | null;
  last_error: string | null;
  checkpoint: string | null;
  created_at: number;
  updated_at: number;
};

/** A wake job's payload. Owner fields are set on a root's mirror of a facet's wake. */
type OutboxJobPayload = {
  readonly id: string;
  readonly owner_path?: string;
  readonly owner_path_key?: string;
};

type OutboxRouteMessage =
  | { readonly type: "wake"; readonly id: string; readonly time: number | null }
  | { readonly type: "dispatch"; readonly id: string }
  | { readonly type: "sealed"; readonly id: string };

function isOutboxJobPayload(value: unknown): value is OutboxJobPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as OutboxJobPayload).id === "string"
  );
}

function parseJson(text: string | null): unknown {
  return text === null ? undefined : JSON.parse(text);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validatePolicy(policy: OutboxRetryPolicy | undefined): void {
  if (!policy) return;
  for (const [name, value] of Object.entries(policy)) {
    if (value === undefined) continue;
    if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
      throw new Error(`Outbox retry.${name} must be a non-negative number`);
    }
  }
  if (policy.maxAttempts !== undefined && policy.maxAttempts < 1) {
    throw new Error("Outbox retry.maxAttempts must be at least 1");
  }
}

/** JSON has no Infinity: an unlimited bound is stored as `"unlimited"`. */
function encodePolicy(policy: OutboxRetryPolicy): string {
  return JSON.stringify(policy, (_key, value: unknown) =>
    value === Number.POSITIVE_INFINITY ? "unlimited" : value
  );
}

function decodePolicy(json: string): OutboxRetryPolicy {
  return JSON.parse(json, (_key, value: unknown) =>
    value === "unlimited" ? Number.POSITIVE_INFINITY : value
  ) as OutboxRetryPolicy;
}

/**
 * Durable delivery until acknowledged, for a Lifecycle Object.
 *
 * Declare sinks in the constructor and install the instance with
 * `Lifecycle.use()`. `send(sink, payload, { key })` stores the value and
 * delivers it from the alarm. A sink acknowledges by returning; a throw
 * fails the attempt and the delivery backs off. Sending to a key that has
 * not been delivered yet replaces its value. Delivery is at least once:
 * sinks must be idempotent, and pass `idempotencyKey` on to a receiver that
 * can drop repeats.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class Outbox<
  Sinks extends OutboxSinks = OutboxSinks
> extends LifecycleCapability {
  readonly #sinks: OutboxSinks;
  readonly #registered = new Map<string, OutboxSink<never>>();
  readonly #retryDefaults: Required<OutboxRetryPolicy>;
  /** Attempts running in this isolate, by delivery id. */
  readonly #active = new Map<string, Promise<void>>();
  /** Whether the table was seen; cleared when a rollback dropped it. */
  #tableSeen = false;

  constructor(options: OutboxOptions<Sinks> = {}) {
    super("outbox");
    validatePolicy(options.retry);
    this.#sinks = options.sinks ?? {};
    for (const [name, sink] of Object.entries(this.#sinks)) {
      validatePolicy(sink.retry);
      if (name.startsWith("__cf")) {
        throw new Error(
          `Outbox sink names must not use the reserved "__cf" prefix`
        );
      }
    }
    this.#retryDefaults = { ...DEFAULT_RETRY, ...options.retry };
  }

  /**
   * @internal Framework aperture: register a reserved (`__cf`-prefixed)
   * sink from a host's constructor, so it is there on every wake.
   */
  register(name: string, sink: OutboxSink<never>): void {
    if (!name.startsWith("__cf")) {
      throw new Error(
        `register() requires a "__cf"-prefixed reserved sink name, got "${name}"`
      );
    }
    if (this.#registered.has(name)) {
      throw new Error(`Outbox sink "${name}" is already registered`);
    }
    validatePolicy(sink.retry);
    this.#registered.set(name, sink);
  }

  // ── Lifecycle hooks ──────────────────────────────────────────────────────

  /** Purge old failures and re-arm every pending wake. */
  async onStart(): Promise<void> {
    // The table is created by the first send, so an object that never
    // sends carries none.
    if (!this.#hasTable()) return;
    this.#write(
      `DELETE FROM cf_agents_outbox WHERE status = 'failed' AND updated_at < ?`,
      Date.now() - FAILED_RETENTION_MS
    );
    for (const row of this.#sql<{ id: string }>(
      `SELECT id FROM cf_agents_outbox WHERE status = 'pending'`
    )) {
      await this.#syncWake(row.id);
    }
  }

  /** Run one due delivery. */
  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    const payload = context.job.payload;
    if (!isOutboxJobPayload(payload)) return undefined;
    if (payload.owner_path) {
      return this.#dispatchForOwner(
        {
          key: payload.owner_path_key ?? payload.owner_path,
          data: payload.owner_path
        },
        payload.id
      );
    }
    return this.#dispatch(payload.id, true);
  }

  /**
   * The alarm memory-limit breaker (#1825) struck during a delivery. A
   * strike that does not seal backs the wake off, and the attempt it cost
   * is already counted. A strike that seals deletes the wake, so the
   * delivery gives up now instead of waiting for a start to re-arm it; on
   * a root's mirror of a facet's wake, the facet's row gives up.
   */
  async onMemoryLimit(context: MemoryLimitContext): Promise<void> {
    const job = context.executing;
    if (!context.sealed || job?.capability !== this.capabilityId) return;
    if (!isOutboxJobPayload(job.payload)) return;
    if (!job.payload.owner_path) {
      await this.#sealed(job.payload.id);
      return;
    }
    try {
      await this.lifecycle.routes.to(
        {
          key: job.payload.owner_path_key ?? job.payload.owner_path,
          data: job.payload.owner_path
        },
        { type: "sealed", id: job.payload.id } satisfies OutboxRouteMessage
      );
    } catch (error) {
      console.error(
        `[Outbox] could not report a sealed breaker for delivery ${job.payload.id}`,
        error
      );
    }
  }

  async #sealed(id: string): Promise<void> {
    const row = this.#row(id);
    if (row?.status !== "pending") return;
    await this.#giveUp(
      row,
      new Error(
        "Sealed by the alarm memory-limit circuit breaker (#1825) after " +
          "consecutive Durable Object memory-limit resets."
      )
    );
    await this.#syncWake(id);
  }

  /** Handle the wake mirror between a facet and its root. */
  async onRoute(context: LifecycleRouteContext): Promise<unknown> {
    const message = context.payload as OutboxRouteMessage;
    switch (message.type) {
      case "wake": {
        if (!context.source)
          throw new Error("Routed Outbox wake has no source");
        await this.#mirrorWake(context.source, message.id, message.time);
        return true;
      }
      case "dispatch":
        return this.#dispatch(message.id, false);
      case "sealed":
        await this.#sealed(message.id);
        return true;
      default:
        throw new Error("Unknown routed Outbox message");
    }
  }

  // ── API ──────────────────────────────────────────────────────────────────

  /**
   * Store a value for a sink and deliver it. A send to a key that is still
   * pending, held or failed replaces its value and starts it over; an
   * attempt already running finishes with the old value, and the new value
   * is delivered after it.
   *
   * Once the Lifecycle has started, the row is written before this method's
   * promise is returned, so a caller's writes in the same synchronous block
   * commit with it.
   */
  async send<Name extends keyof Sinks & string>(
    sink: Name,
    payload: OutboxPayload<Sinks[Name]>,
    options?: OutboxSendOptions
  ): Promise<OutboxDelivery<OutboxPayload<Sinks[Name]>>>;
  async send(
    sink: string,
    payload: unknown,
    options?: OutboxSendOptions
  ): Promise<OutboxDelivery>;
  async send(
    sink: string,
    payload: unknown,
    options: OutboxSendOptions = {}
  ): Promise<OutboxDelivery> {
    if (this.lifecycle.status() !== "started") await this.lifecycle.ready();
    if (!this.#resolveSink(sink)) {
      throw new Error(`Unknown Outbox sink "${sink}"`);
    }
    if (options.key !== undefined && options.key === "") {
      throw new Error("Outbox keys must be non-empty");
    }
    validatePolicy(options.retry);
    const json = this.#encode(sink, payload);
    const key = options.key ?? nanoid();
    const now = Date.now();
    this.#ensureTable();
    const status: OutboxDeliveryStatus = options.hold ? "held" : "pending";
    this.#write(
      `INSERT INTO cf_agents_outbox
         (id, sink, key, payload, idempotency_key, status, retry_options,
          attempts, first_attempt_at, next_at, last_error, checkpoint,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL, NULL, ?, ?)
       ON CONFLICT (sink, key) DO UPDATE SET
         payload = excluded.payload,
         idempotency_key = excluded.idempotency_key,
         status = excluded.status,
         retry_options = excluded.retry_options,
         attempts = 0,
         first_attempt_at = NULL,
         next_at = excluded.next_at,
         last_error = NULL,
         checkpoint = NULL,
         updated_at = excluded.updated_at`,
      nanoid(),
      sink,
      key,
      json,
      nanoid(),
      status,
      options.retry ? encodePolicy(options.retry) : null,
      options.hold ? null : now,
      now,
      now
    );
    const row = this.#rowByKey(sink, key);
    if (!row)
      throw new Error(`Failed to store Outbox delivery "${sink}/${key}"`);
    const wake = this.#syncWake(row.id);
    this.#emit("outbox:send", { sink, key, id: row.id, held: !!options.hold });
    await wake;
    return this.#delivery(row);
  }

  /**
   * Release a held delivery: it becomes pending and is delivered.
   * `update` maps the held value to the one to deliver. The read and the
   * write happen together, so of two concurrent releases one wins and the
   * other returns false. Returns false when no held delivery matched.
   */
  async release<T = unknown>(
    sink: string,
    key: string,
    update?: (held: T) => T
  ): Promise<boolean> {
    await this.lifecycle.ready();
    const row = this.#rowByKey(sink, key);
    if (!row || row.status !== "held") return false;
    const payload = update
      ? update(parseJson(row.payload) as T)
      : (parseJson(row.payload) as T);
    const json = this.#encode(sink, payload);
    const now = Date.now();
    this.#write(
      `UPDATE cf_agents_outbox
       SET status = 'pending', payload = ?, next_at = ?, updated_at = ?
       WHERE id = ? AND status = 'held'`,
      json,
      now,
      now,
      row.id
    );
    await this.#syncWake(row.id);
    return true;
  }

  /** Read one delivery. Acknowledged deliveries are gone. */
  async get<T = unknown>(
    sink: string,
    key: string
  ): Promise<OutboxDelivery<T> | undefined> {
    await this.lifecycle.ready();
    const row = this.#rowByKey(sink, key);
    return row ? this.#delivery<T>(row) : undefined;
  }

  /** List deliveries, oldest first. */
  async list<T = unknown>(
    options: OutboxListOptions = {}
  ): Promise<OutboxDelivery<T>[]> {
    await this.lifecycle.ready();
    const statuses =
      options.status === undefined
        ? undefined
        : Array.isArray(options.status)
          ? options.status
          : [options.status];
    const where: string[] = [];
    const params: string[] = [];
    if (options.sink !== undefined) {
      where.push("sink = ?");
      params.push(options.sink);
    }
    if (statuses !== undefined) {
      where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
    return this.#sql<OutboxRow>(
      `SELECT * FROM cf_agents_outbox
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at ASC, rowid ASC`,
      ...params
    ).map((row) => this.#delivery<T>(row));
  }

  /** Drop one delivery, whatever its status. Returns false when none matched. */
  async cancel(sink: string, key: string): Promise<boolean> {
    await this.lifecycle.ready();
    const row = this.#rowByKey(sink, key);
    if (!row) return false;
    this.#write(`DELETE FROM cf_agents_outbox WHERE id = ?`, row.id);
    await this.#syncWake(row.id);
    return true;
  }

  /**
   * Start a failed delivery over with the same value and idempotency key.
   * Returns false when no failed delivery matched.
   */
  async retry(sink: string, key: string): Promise<boolean> {
    await this.lifecycle.ready();
    const row = this.#rowByKey(sink, key);
    if (!row || row.status !== "failed") return false;
    this.#write(
      `UPDATE cf_agents_outbox
       SET status = 'pending', attempts = 0, first_attempt_at = NULL,
           next_at = ?, last_error = NULL, updated_at = ?
       WHERE id = ?`,
      Date.now(),
      Date.now(),
      row.id
    );
    await this.#syncWake(row.id);
    return true;
  }

  /** Delete failed deliveries, optionally only those last changed before a time. */
  async purge(options: { before?: Date } = {}): Promise<number> {
    await this.lifecycle.ready();
    return this.#sql(
      `DELETE FROM cf_agents_outbox WHERE status = 'failed' AND updated_at < ?
       RETURNING id`,
      options.before?.getTime() ?? Number.MAX_SAFE_INTEGER
    ).length;
  }

  // ── Delivery ─────────────────────────────────────────────────────────────

  /**
   * Run one attempt of a due delivery. `bounded` dispatches hold the alarm
   * loop for at most the dispatch budget; the attempt then runs on,
   * tracked by the alarm's memory-limit breaker, behind a lease wake.
   */
  async #dispatch(id: string, bounded: boolean): Promise<LifecycleJobOutcome> {
    const active = this.#active.get(id);
    if (active) {
      this.lifecycle.trackAlarmWork(active);
      return { rescheduleAt: Date.now() + ATTEMPT_LEASE_MS };
    }
    const row = this.#row(id);
    if (!row || row.status !== "pending" || row.next_at === null) {
      return undefined;
    }
    const now = Date.now();
    if (row.next_at > now) return { rescheduleAt: row.next_at };

    const policy = this.#policy(row);
    if (
      row.attempts >= policy.maxAttempts ||
      (row.first_attempt_at !== null &&
        now - row.first_attempt_at >= policy.giveUpAfterMs)
    ) {
      // The last attempt never reported back: the isolate died during it.
      await this.#giveUp(
        row,
        new Error(row.last_error ?? "The delivery attempt was interrupted")
      );
      return this.#wakeOutcome(id);
    }

    // Count the attempt before it runs, so an attempt that takes the
    // isolate down still counts toward giving up.
    const attempt = row.attempts + 1;
    this.#write(
      `UPDATE cf_agents_outbox
       SET attempts = ?, first_attempt_at = coalesce(first_attempt_at, ?),
           next_at = ?, updated_at = ?
       WHERE id = ? AND idempotency_key = ?`,
      attempt,
      now,
      now + ATTEMPT_LEASE_MS,
      now,
      id,
      row.idempotency_key
    );
    const claimed: OutboxRow = {
      ...row,
      attempts: attempt,
      first_attempt_at: row.first_attempt_at ?? now
    };
    const run = this.#attempt(claimed).finally(() => {
      if (this.#active.get(id) === run) this.#active.delete(id);
    });
    this.#active.set(id, run);

    if (!bounded) {
      await run;
      return this.#wakeOutcome(id);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<"budget">((resolve) => {
      timer = setTimeout(() => resolve("budget"), DISPATCH_BUDGET_MS);
    });
    try {
      const winner = await Promise.race([
        run.then(() => "done" as const),
        budget
      ]);
      if (winner === "budget") {
        this.lifecycle.trackAlarmWork(run);
        return { rescheduleAt: Date.now() + ATTEMPT_LEASE_MS };
      }
    } finally {
      clearTimeout(timer);
    }
    return this.#wakeOutcome(id);
  }

  async #attempt(row: OutboxRow): Promise<void> {
    const sink = this.#resolveSink(row.sink);
    const context: OutboxDeliveryContext = {
      id: row.id,
      sink: row.sink,
      key: row.key,
      idempotencyKey: row.idempotency_key,
      attempt: row.attempts,
      checkpoint: parseJson(row.checkpoint),
      saveCheckpoint: async (value) => {
        this.#write(
          `UPDATE cf_agents_outbox SET checkpoint = ?, updated_at = ?
           WHERE id = ? AND idempotency_key = ?`,
          value === undefined ? null : JSON.stringify(value),
          Date.now(),
          row.id,
          row.idempotency_key
        );
      }
    };
    try {
      if (!sink) throw new Error(`No Outbox sink "${row.sink}" is registered`);
      const payload = parseJson(row.payload) as never;
      await this.lifecycle.runInHostContext(() =>
        sink.deliver(payload, context)
      );
    } catch (error) {
      // The isolate is going away; the lease wake runs this again.
      if (
        isDurableObjectMemoryLimitReset(error) ||
        isDurableObjectResetError(error)
      ) {
        throw error;
      }
      await this.#fail(row, error);
      return;
    }
    // Acknowledged. A value sent during the attempt stays for its own.
    const acknowledged = this.#write(
      `DELETE FROM cf_agents_outbox WHERE id = ? AND idempotency_key = ?`,
      row.id,
      row.idempotency_key
    );
    if (acknowledged > 0) {
      this.#emit("outbox:deliver", {
        sink: row.sink,
        key: row.key,
        id: row.id,
        attempt: row.attempts
      });
    }
    await this.#syncWake(row.id);
  }

  async #fail(row: OutboxRow, error: unknown): Promise<void> {
    const policy = this.#policy(row);
    const now = Date.now();
    const delay = Math.min(
      policy.maxDelayMs,
      policy.baseDelayMs * 2 ** Math.min(row.attempts - 1, 30)
    );
    const firstAttemptAt = row.first_attempt_at ?? now;
    if (
      row.attempts >= policy.maxAttempts ||
      now + delay - firstAttemptAt > policy.giveUpAfterMs
    ) {
      await this.#giveUp(row, error);
      await this.#syncWake(row.id);
      return;
    }
    const nextAt = now + delay;
    const changed = this.#write(
      `UPDATE cf_agents_outbox
       SET next_at = ?, last_error = ?, updated_at = ?
       WHERE id = ? AND idempotency_key = ? AND status = 'pending'`,
      nextAt,
      errorMessage(error),
      now,
      row.id,
      row.idempotency_key
    );
    if (changed > 0) {
      console.warn(
        `[Outbox] delivery ${row.sink}/${row.key} failed (attempt ${row.attempts}); ` +
          `retrying in ${Math.round(delay / 1000)}s`,
        error
      );
      this.#emit("outbox:retry", {
        sink: row.sink,
        key: row.key,
        id: row.id,
        attempt: row.attempts,
        nextAt,
        error: errorMessage(error)
      });
    }
    await this.#syncWake(row.id);
  }

  async #giveUp(row: OutboxRow, error: unknown): Promise<void> {
    const now = Date.now();
    const changed = this.#write(
      `UPDATE cf_agents_outbox
       SET status = 'failed', next_at = NULL, last_error = ?, updated_at = ?
       WHERE id = ? AND idempotency_key = ? AND status = 'pending'`,
      errorMessage(error),
      now,
      row.id,
      row.idempotency_key
    );
    if (changed === 0) return;
    console.error(
      `[Outbox] delivery ${row.sink}/${row.key} gave up after ${row.attempts} attempts`,
      error
    );
    this.#emit("outbox:give_up", {
      sink: row.sink,
      key: row.key,
      id: row.id,
      attempts: row.attempts,
      error: errorMessage(error)
    });
    const failed = this.#row(row.id);
    const sink = this.#resolveSink(row.sink);
    if (!failed || !sink?.onGiveUp) return;
    const onGiveUp = sink.onGiveUp;
    try {
      await this.lifecycle.runInHostContext(() =>
        onGiveUp(
          parseJson(failed.payload) as never,
          this.#delivery(failed) as OutboxDelivery<never>,
          error
        )
      );
    } catch (hookError) {
      console.error(`[Outbox] onGiveUp for ${row.sink} threw`, hookError);
    }
  }

  // ── Wakes ────────────────────────────────────────────────────────────────

  /** The queue outcome for a delivery's own wake job, from its row. */
  #wakeOutcome(id: string): LifecycleJobOutcome {
    const row = this.#row(id);
    return row?.status === "pending" && row.next_at !== null
      ? { rescheduleAt: row.next_at }
      : undefined;
  }

  /**
   * Mirror one delivery's next attempt into the job queue: one job while it
   * is pending, none otherwise. On a facet the wake mirrors to the root,
   * which owns the alarm; the row stays here.
   */
  async #syncWake(id: string): Promise<void> {
    const row = this.#row(id);
    const time =
      row?.status === "pending" && row.next_at !== null ? row.next_at : null;
    if (this.lifecycle.routes.source) {
      await this.lifecycle.routes.toRoot({
        type: "wake",
        id,
        time
      } satisfies OutboxRouteMessage);
      return;
    }
    await this.#pushWake(`${JOB_PREFIX}${id}`, time, { id });
  }

  async #mirrorWake(
    owner: LifecycleRouteAddress,
    id: string,
    time: number | null
  ): Promise<void> {
    await this.#pushWake(`${JOB_PREFIX}${owner.key}:${id}`, time, {
      id,
      owner_path: owner.data,
      owner_path_key: owner.key
    });
  }

  async #pushWake(
    jobId: string,
    time: number | null,
    payload: OutboxJobPayload
  ): Promise<void> {
    if (time === null) {
      await this.lifecycle.jobs.cancel(jobId);
      return;
    }
    await this.lifecycle.jobs.push({
      id: jobId,
      fn: JOB_FN,
      time,
      payload,
      retry: JOB_RETRY
    });
  }

  /** Dispatch a root's mirror of a facet's wake back to the facet. */
  async #dispatchForOwner(
    owner: LifecycleRouteAddress,
    id: string
  ): Promise<LifecycleJobOutcome> {
    const call = this.lifecycle.routes.to(owner, {
      type: "dispatch",
      id
    } satisfies OutboxRouteMessage);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<"budget">((resolve) => {
      timer = setTimeout(() => resolve("budget"), DISPATCH_BUDGET_MS);
    });
    try {
      const winner = await Promise.race([
        call.then((outcome) => ({ outcome })),
        budget
      ]);
      if (winner === "budget") {
        this.lifecycle.trackAlarmWork(call);
        // The facet re-mirrors its wake when the attempt ends.
        return { rescheduleAt: Date.now() + ATTEMPT_LEASE_MS };
      }
      // `false`: the facet is gone.
      if (winner.outcome === false) return undefined;
      return winner.outcome as LifecycleJobOutcome;
    } catch (error) {
      if (isPlatformFailure(error)) throw error;
      console.error(`[Outbox] routed delivery ${id} failed to dispatch`, error);
      return { rescheduleAt: Date.now() + DEFAULT_RETRY.baseDelayMs };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @internal Cancel this root's wake mirrors for a deleted facet subtree;
   * the rows went with the facet's storage.
   */
  async __DO_NOT_USE_WILL_BREAK__cleanupRoutePrefix(
    prefix: string
  ): Promise<void> {
    for (const job of this.lifecycle.jobs.list()) {
      const payload = isOutboxJobPayload(job.payload) ? job.payload : undefined;
      const ownerKey = payload?.owner_path_key ?? payload?.owner_path;
      if (!ownerKey) continue;
      if (ownerKey !== prefix && !ownerKey.startsWith(`${prefix}/`)) continue;
      await this.lifecycle.jobs.cancel(job.id);
    }
  }

  // ── Storage ──────────────────────────────────────────────────────────────

  #encode(sink: string, payload: unknown): string | null {
    const json = payload === undefined ? null : JSON.stringify(payload);
    if (
      json !== null &&
      encoder.encode(json).byteLength > MAX_OUTBOX_PAYLOAD_BYTES
    ) {
      throw new Error(
        `Outbox payload for "${sink}" is over ${MAX_OUTBOX_PAYLOAD_BYTES} bytes`
      );
    }
    return json;
  }

  #resolveSink(name: string): OutboxSink<never> | undefined {
    return this.#sinks[name] ?? this.#registered.get(name);
  }

  #policy(row: OutboxRow): Required<OutboxRetryPolicy> {
    const own =
      row.retry_options === null ? undefined : decodePolicy(row.retry_options);
    return {
      ...this.#retryDefaults,
      ...this.#resolveSink(row.sink)?.retry,
      ...own
    };
  }

  #delivery<T>(row: OutboxRow): OutboxDelivery<T> {
    return {
      id: row.id,
      sink: row.sink,
      key: row.key,
      idempotencyKey: row.idempotency_key,
      payload: parseJson(row.payload) as T,
      status: row.status,
      attempts: row.attempts,
      firstAttemptAt: row.first_attempt_at,
      nextAt: row.status === "pending" ? row.next_at : null,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  #row(id: string): OutboxRow | undefined {
    return this.#sql<OutboxRow>(
      `SELECT * FROM cf_agents_outbox WHERE id = ?`,
      id
    )[0];
  }

  #rowByKey(sink: string, key: string): OutboxRow | undefined {
    return this.#sql<OutboxRow>(
      `SELECT * FROM cf_agents_outbox WHERE sink = ? AND key = ?`,
      sink,
      key
    )[0];
  }

  /**
   * Create the table. Runs on every send rather than once: a send inside a
   * transaction that rolls back takes the table with it.
   */
  #ensureTable(): void {
    this.lifecycle.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cf_agents_outbox (
        id TEXT PRIMARY KEY NOT NULL,
        sink TEXT NOT NULL,
        key TEXT NOT NULL,
        payload TEXT,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        retry_options TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        first_attempt_at INTEGER,
        next_at INTEGER,
        last_error TEXT,
        checkpoint TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (sink, key)
      )`);
    this.#tableSeen = true;
  }

  #hasTable(): boolean {
    this.#tableSeen ||=
      this.lifecycle.storage.sql
        .exec(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_outbox'"
        )
        .toArray().length > 0;
    return this.#tableSeen;
  }

  /**
   * Run one statement. Before the first send there is no table and nothing
   * to read; a rolled-back first send can drop the table after it was seen.
   */
  #exec<T>(
    query: string,
    params: (string | number | null)[],
    read: (cursor: SqlStorageCursor<Record<string, SqlStorageValue>>) => T,
    empty: T
  ): T {
    if (!this.#hasTable()) return empty;
    try {
      return read(this.lifecycle.storage.sql.exec(query, ...params));
    } catch (cause) {
      if (/no such table: cf_agents_outbox/.test(String(cause))) {
        this.#tableSeen = false;
        return empty;
      }
      throw new SqlError(query, cause);
    }
  }

  #sql<T>(query: string, ...params: (string | number | null)[]): T[] {
    // SAFETY: T names the columns the query selects from this table.
    return this.#exec(query, params, (cursor) => [...cursor] as T[], []);
  }

  #write(query: string, ...params: (string | number | null)[]): number {
    return this.#exec(query, params, (cursor) => cursor.rowsWritten, 0);
  }

  #emit(type: OutboxEventType, payload: Record<string, unknown>): void {
    this.lifecycle.events.emit(type, payload);
  }
}
