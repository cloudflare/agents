/**
 * Work that runs once, and work that waits for a decision.
 *
 * `Approvals` owns two tables. `cf_agents_effects` is an effect ledger: a
 * side effect claimed by key runs once and its value is recorded, so a
 * retry gets the value instead of a second run. `cf_agents_decisions` holds
 * parked decisions: work that waits until someone approves or rejects it,
 * then runs its continuation, durably, across resets.
 *
 * It consumes only the standard capability services: storage, the job
 * queue (one recovery job per unfinished decision), the host invocation
 * boundary and events.
 */

import { LifecycleCapability } from "../lifecycle/capability";
import type {
  LifecycleJobContext,
  LifecycleJobOutcome
} from "../lifecycle/job-queue";
import { SqlError } from "../sql-error";
import { stableHash, stableStringify } from "./hash";
import type {
  ApprovalsEventType,
  ApprovalsOptions,
  ApprovalsRetention,
  DecideResult,
  Decision,
  DecisionStatus,
  EffectOptions,
  EffectOutcome,
  EffectRecord,
  ParkOptions,
  Verdict
} from "./types";

const SCHEMA_VERSION_KEY = "cf_agents:approvals_schema_version";
const CURRENT_SCHEMA_VERSION = 1;
const LAST_SWEPT_KEY = "cf_agents:approvals_last_swept_at";
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RESUME_AFTER_MS = 60_000;
/** Failed continuation attempts before a decision settles with its error. */
const MAX_CONTINUATION_ATTEMPTS = 3;
const RESUME_FN = "resume";
const RESUME_JOB_PREFIX = "decision:";

const DEFAULT_RETENTION: Required<ApprovalsRetention> = {
  effectSettledMs: 30 * DAY_MS,
  effectPendingMs: 90 * DAY_MS,
  decisionPendingMs: 30 * DAY_MS,
  decisionSettledMs: 30 * DAY_MS,
  maxSweepRows: 500
};

type SqlValue = string | number | null;

type EffectRow = {
  key: string;
  name: string;
  input_hash: string;
  status: "pending" | "settled";
  result_json: string | null;
  context_json: string | null;
  created_at: number;
  updated_at: number;
};

type DecisionRow = {
  id: string;
  kind: string;
  subject_json: string;
  descriptor_json: string | null;
  status: DecisionStatus;
  verdict_json: string | null;
  outcome_json: string | null;
  error: string | null;
  attempts: number;
  acknowledged: number;
  created_at: number;
  decided_at: number | null;
  settled_at: number | null;
};

/** @internal A recorded effect as a migration imports it. */
export type ImportedEffect = {
  readonly key: string;
  readonly name: string;
  readonly inputHash: string;
  readonly status: "pending" | "settled";
  /** Recorded value in the ledger's encoding (see `encodeValue`). */
  readonly resultJson: string | null;
  readonly context?: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/** @internal A decision as a migration imports it. */
export type ImportedDecision = {
  readonly id: string;
  readonly kind: string;
  readonly subject: unknown;
  readonly descriptor?: unknown;
  readonly status: "pending" | "settled";
  readonly verdict?: Verdict;
  readonly outcome?: unknown;
  readonly createdAt: number;
  readonly settledAt?: number;
};

/**
 * The recorded form of an effect's value. `valuePresent` tells a recorded
 * `undefined` apart from a missing value. The same encoding Think's action
 * ledger wrote, so its rows still replay.
 */
function encodeValue(
  value: unknown
): { ok: true; json: string; value: unknown } | { ok: false } {
  try {
    const json = JSON.stringify({ valuePresent: value !== undefined, value });
    if (json === undefined) return { ok: false };
    const parsed = JSON.parse(json) as {
      valuePresent: boolean;
      value?: unknown;
    };
    if (value !== undefined && !("value" in parsed)) return { ok: false };
    return {
      ok: true,
      json,
      value: parsed.valuePresent ? parsed.value : undefined
    };
  } catch {
    return { ok: false };
  }
}

function decodeValue(json: string | null): unknown {
  if (json === null) return undefined;
  const parsed = JSON.parse(json) as {
    valuePresent?: unknown;
    value?: unknown;
  };
  return parsed.valuePresent === true ? parsed.value : undefined;
}

function parseJson(json: string | null): unknown {
  if (json === null) return undefined;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

function toJson(value: unknown, what: string): string | null {
  if (value === undefined) return null;
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError(`Approvals: ${what} must be JSON`);
  }
  return json;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resumeJobId(id: string): string {
  return `${RESUME_JOB_PREFIX}${id}`;
}

/**
 * Run side effects once, and park work until someone decides.
 *
 * Install the instance with `Lifecycle.use()`. The continuation of a
 * decision ({@link ApprovalsOptions.onDecided}) and the hand-off of its
 * outcome ({@link ApprovalsOptions.onSettled}) are passed in, and run in
 * host context.
 *
 * Durable: effect claims and recorded values; every decision with its
 * verdict and outcome; one recovery job per unfinished decision. In memory:
 * the running effects and continuations (so callers in the same isolate
 * share them) and {@link wait} waiters.
 */
export class Approvals extends LifecycleCapability {
  readonly #options: ApprovalsOptions;
  #tablesEnsured = false;
  readonly #runningEffects = new Map<
    string,
    {
      name: string;
      inputHash: string;
      promise: Promise<EffectOutcome<unknown>>;
    }
  >();
  readonly #runningDecisions = new Map<string, Promise<Decision>>();
  readonly #waiters = new Map<
    string,
    Set<{ done: (decision: Decision) => void; fail: (error: Error) => void }>
  >();

  constructor(options: ApprovalsOptions = {}) {
    super("approvals");
    this.#options = options;
  }

  // ── Lifecycle hooks ──────────────────────────────────────────────────────

  /**
   * Create the tables, sweep expired rows at most once an hour, and make
   * sure every unfinished decision has a recovery job.
   */
  async onStart(): Promise<void> {
    const storage = this.lifecycle.storage;
    const version = (await storage.get<number>(SCHEMA_VERSION_KEY)) ?? 0;
    this.#ensureTables();
    if (version < CURRENT_SCHEMA_VERSION) {
      await storage.put(SCHEMA_VERSION_KEY, CURRENT_SCHEMA_VERSION);
    }
    try {
      await this.sweep();
    } catch (error) {
      // A failed sweep only delays deletion; it must not fail startup.
      console.error("[Approvals] Sweep failed:", error);
    }
    for (const row of this.#sql<{ id: string }>`
      SELECT id FROM cf_agents_decisions
      WHERE status = ${"decided"}
         OR (status = ${"settled"} AND acknowledged = 0)
    `) {
      if (!this.lifecycle.jobs.get(resumeJobId(row.id))) {
        await this.#pushResume(row.id, Date.now());
      }
    }
  }

  /** Run or hand off one unfinished decision after a reset. */
  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    if (context.job.fn !== RESUME_FN) return undefined;
    const id = (context.job.payload as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string") return undefined;
    const row = this.#readDecision(id);
    if (!row || row.status === "pending") return undefined;

    const running = this.#runningDecisions.get(id);
    if (running) {
      // This isolate is still running it: look again later.
      return { rescheduleAt: Date.now() + this.#resumeAfterMs() };
    }
    if (row.status === "decided") {
      // Detached: a continuation can outlast a bounded job dispatch. The job
      // stays due later, so a reset during it runs it again; settling
      // cancels the job.
      const work = this.#continue(id, { redelivered: false }).catch(
        (error: unknown) => {
          // The job is still due: it runs the continuation again.
          console.error(`[Approvals] Continuation of "${id}" failed:`, error);
        }
      );
      this.lifecycle.trackAlarmWork(work);
      return { rescheduleAt: Date.now() + this.#resumeAfterMs() };
    }
    if (row.acknowledged === 0) {
      try {
        await this.#settle(this.#toDecision(row), { redelivered: true });
      } catch (error) {
        console.error(`[Approvals] Hand-off of "${id}" failed:`, error);
        return { rescheduleAt: Date.now() + this.#resumeAfterMs() };
      }
    }
    return undefined;
  }

  // ── Effect ledger ────────────────────────────────────────────────────────

  /**
   * Run `options.run` once for `options.key`, and record its value.
   *
   * A later call with the same key, name and input returns the recorded
   * value without running (`replayed`). A call while the same isolate runs
   * the key shares that run. A claim whose attempt never finished (its
   * isolate ended) answers `in-doubt` and does not run, unless the caller
   * allowed a takeover with `reclaimAfterMs`. If `run` throws, the claim is
   * released and the error is rethrown: a later call runs again.
   *
   * The value returned is the recorded JSON form, also on the first run,
   * so a replay returns the same value the first caller saw.
   */
  async once<T>(options: EffectOptions<T>): Promise<EffectOutcome<T>> {
    const { key, name, input, run } = options;
    if (key.length === 0) {
      throw new TypeError("Approvals.once: key must be non-empty");
    }
    this.#ensureTables();
    const inputHash = stableHash(input);
    const running = this.#runningEffects.get(key);
    if (running) {
      if (running.name !== name || running.inputHash !== inputHash) {
        this.#emit("approvals:effect:conflict", { key, name });
        return { status: "conflict" };
      }
      return (await running.promise) as EffectOutcome<T>;
    }

    const contextJson = toJson(options.context, "context");
    const now = Date.now();
    const existing = this.#readEffect(key);
    let reclaimedAge: number | undefined;
    if (existing) {
      if (existing.name !== name || existing.input_hash !== inputHash) {
        this.#emit("approvals:effect:conflict", { key, name });
        return { status: "conflict" };
      }
      if (existing.status === "settled") {
        this.#emit("approvals:effect:replayed", { key, name });
        return {
          status: "replayed",
          value: decodeValue(existing.result_json) as T
        };
      }
      const ageMs = now - existing.updated_at;
      const reclaimAfter = options.reclaimAfterMs ?? false;
      if (reclaimAfter === false || ageMs <= reclaimAfter) {
        this.#emit("approvals:effect:in-doubt", { key, name, ageMs });
        return { status: "in-doubt", ageMs };
      }
      // No await since the read: within this isolate nothing can take the
      // same claim in between.
      this.#write(
        `UPDATE cf_agents_effects SET context_json = ?, updated_at = ?
         WHERE key = ? AND status = 'pending'`,
        [contextJson, now, key]
      );
      reclaimedAge = ageMs;
    } else {
      this.#write(
        `INSERT INTO cf_agents_effects
           (key, name, input_hash, status, result_json, context_json, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', NULL, ?, ?, ?)`,
        [key, name, inputHash, contextJson, now, now]
      );
    }

    const execution = (async (): Promise<EffectOutcome<T>> => {
      let value: T;
      try {
        value = await run();
      } catch (error) {
        this.#releaseEffect(key);
        throw error;
      }
      const encoded = encodeValue(value);
      if (!encoded.ok) {
        this.#releaseEffect(key);
        this.#emit("approvals:effect:unrecorded", { key, name });
        return { status: "unrecorded", value };
      }
      let settled: number;
      try {
        settled = this.#write(
          `UPDATE cf_agents_effects
           SET status = 'settled', result_json = ?, updated_at = ?
           WHERE key = ? AND status = 'pending'`,
          [encoded.json, Date.now(), key]
        );
      } catch {
        // SQLite will not store the value (past its 2 MB row limit). The
        // effect ran; nothing is recorded, as for a value that is not JSON.
        this.#releaseEffect(key);
        settled = 0;
      }
      if (settled === 0) {
        // The claim is gone (deleted while the effect ran): nothing recorded.
        this.#emit("approvals:effect:unrecorded", { key, name });
        return { status: "unrecorded", value };
      }
      const recorded = encoded.value as T;
      if (reclaimedAge !== undefined) {
        this.#emit("approvals:effect:reclaimed", {
          key,
          name,
          ageMs: reclaimedAge
        });
        return { status: "reclaimed", value: recorded, ageMs: reclaimedAge };
      }
      this.#emit("approvals:effect:ran", { key, name });
      return { status: "ran", value: recorded };
    })();
    this.#runningEffects.set(key, { name, inputHash, promise: execution });
    try {
      return await execution;
    } finally {
      this.#runningEffects.delete(key);
    }
  }

  /** The recorded effect under `key`, if any. */
  effect(key: string): EffectRecord | undefined {
    this.#ensureTables();
    const row = this.#readEffect(key);
    if (!row) return undefined;
    return {
      key: row.key,
      name: row.name,
      inputHash: row.input_hash,
      status: row.status,
      value:
        row.status === "settled" ? decodeValue(row.result_json) : undefined,
      context: parseJson(row.context_json) as
        | Record<string, unknown>
        | undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  // ── Decisions ────────────────────────────────────────────────────────────

  /**
   * Park work until someone decides. Parking an id again with the same
   * kind and subject returns the existing record; with another kind or
   * subject it throws.
   */
  park(options: ParkOptions): Decision {
    this.#ensureTables();
    const id = options.id ?? `decision_${crypto.randomUUID()}`;
    const subjectJson = toJson(options.subject, "subject") ?? "null";
    const descriptorJson = toJson(options.descriptor, "descriptor");
    const existing = this.#readDecision(id);
    if (existing) {
      if (
        existing.kind !== options.kind ||
        stableStringify(parseJson(existing.subject_json)) !==
          stableStringify(options.subject)
      ) {
        throw new Error(
          `Approvals.park: decision "${id}" exists with another kind or subject`
        );
      }
      return this.#toDecision(existing);
    }
    this.#write(
      `INSERT INTO cf_agents_decisions
         (id, kind, subject_json, descriptor_json, status, attempts, acknowledged, created_at)
       VALUES (?, ?, ?, ?, 'pending', 0, 0, ?)`,
      [id, options.kind, subjectJson, descriptorJson, Date.now()]
    );
    this.#emit("approvals:decision:parked", { id, kind: options.kind });
    const row = this.#readDecision(id);
    if (!row) throw new Error(`Approvals.park: decision "${id}" not stored`);
    return this.#toDecision(row);
  }

  /** The decision under `id`, whatever its status. */
  get(id: string): Decision | undefined {
    this.#ensureTables();
    const row = this.#readDecision(id);
    return row ? this.#toDecision(row) : undefined;
  }

  /** Every decision nobody has made yet, oldest first. */
  pending(): Decision[] {
    this.#ensureTables();
    return this.#sql<DecisionRow>`
      SELECT * FROM cf_agents_decisions
      WHERE status = ${"pending"}
      ORDER BY created_at ASC, id ASC
    `.map((row) => this.#toDecision(row));
  }

  /**
   * Decide a pending decision, run its continuation, record the outcome,
   * and hand it off. One verdict wins: a later call, from any tab or after
   * a reset, gets `already-decided` with the record.
   *
   * The verdict is stored before the continuation runs, with a recovery
   * job, so a reset during the continuation runs it again. If the
   * continuation throws, the error is rethrown here and the job retries
   * it; after three failed attempts the decision settles with the error.
   */
  async decide(id: string, verdict: Verdict): Promise<DecideResult> {
    this.#ensureTables();
    const verdictJson = toJson(verdict, "verdict");
    const row = this.#readDecision(id);
    if (!row) return { status: "not-found" };
    if (row.status !== "pending") {
      return { status: "already-decided", decision: this.#toDecision(row) };
    }
    const now = Date.now();
    // Read and write with no await between them: one caller wins.
    const changed = this.#write(
      `UPDATE cf_agents_decisions
       SET status = 'decided', verdict_json = ?, decided_at = ?
       WHERE id = ? AND status = 'pending'`,
      [verdictJson, now, id]
    );
    if (changed === 0) {
      const current = this.#readDecision(id);
      return current
        ? { status: "already-decided", decision: this.#toDecision(current) }
        : { status: "not-found" };
    }
    this.#emit("approvals:decision:decided", {
      id,
      kind: row.kind,
      approved: verdict.approved
    });
    await this.#pushResume(id, now + this.#resumeAfterMs());
    return {
      status: "settled",
      decision: await this.#continue(id, { redelivered: false })
    };
  }

  /**
   * Record a decision made elsewhere, with its outcome, and hand the outcome
   * off ({@link ApprovalsOptions.onSettled}) until it is acknowledged. For
   * work whose own system holds what is pending and runs the decision (a
   * code runtime that pauses on a gated call), so only the hand-off needs a
   * durable record here. `onDecided` does not run.
   */
  async record(
    options: ParkOptions & {
      readonly verdict: Verdict;
      readonly outcome: unknown;
    }
  ): Promise<Decision> {
    this.#ensureTables();
    const id = options.id ?? `decision_${crypto.randomUUID()}`;
    const now = Date.now();
    let outcomeJson: string | null = null;
    let error: string | null = null;
    try {
      outcomeJson = toJson(options.outcome, "outcome");
    } catch (cause) {
      error = errorMessage(cause);
    }
    const insert = (outcome: string | null, failure: string | null) =>
      this.#write(
        `INSERT INTO cf_agents_decisions
           (id, kind, subject_json, descriptor_json, status, verdict_json,
            outcome_json, error, attempts, acknowledged, created_at,
            decided_at, settled_at)
         VALUES (?, ?, ?, ?, 'settled', ?, ?, ?, 0, 0, ?, ?, ?)`,
        [
          id,
          options.kind,
          toJson(options.subject, "subject") ?? "null",
          toJson(options.descriptor, "descriptor"),
          toJson(options.verdict, "verdict"),
          outcome,
          failure,
          now,
          now,
          now
        ]
      );
    try {
      insert(outcomeJson, error);
    } catch (cause) {
      insert(null, `The outcome could not be stored: ${errorMessage(cause)}`);
    }
    this.#emit("approvals:decision:decided", {
      id,
      kind: options.kind,
      approved: options.verdict.approved
    });
    return this.#afterSettle(id, options.kind, { redelivered: false });
  }

  /**
   * Resolve once the decision under `id` is settled. In memory: the record
   * is the truth, so a decision that settled earlier resolves at once.
   * Rejects on timeout, on abort, or when there is no such decision.
   */
  wait(
    id: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<Decision> {
    const current = this.get(id);
    if (!current) {
      return Promise.reject(new Error(`Approvals: no decision "${id}"`));
    }
    if (current.status === "settled") return Promise.resolve(current);
    return new Promise<Decision>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiters = this.#waiters.get(id) ?? new Set();
      this.#waiters.set(id, waiters);
      const entry = {
        done: (decision: Decision) => {
          cleanup();
          resolve(decision);
        },
        fail: (error: Error) => {
          cleanup();
          reject(error);
        }
      };
      const cleanup = () => {
        waiters.delete(entry);
        if (waiters.size === 0) this.#waiters.delete(id);
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(options.signal?.reason ?? new Error("Aborted"));
      };
      waiters.add(entry);
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          cleanup();
          reject(
            new Error(`Approvals: decision "${id}" did not settle in time`)
          );
        }, options.timeoutMs);
      }
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Settled decisions whose outcome the host has not taken up, oldest first. */
  unacknowledged(): Decision[] {
    this.#ensureTables();
    return this.#sql<DecisionRow>`
      SELECT * FROM cf_agents_decisions
      WHERE status = ${"settled"} AND acknowledged = 0
      ORDER BY settled_at ASC, id ASC
    `.map((row) => this.#toDecision(row));
  }

  /** Record that the host has taken the outcome up: it is not handed off again. */
  acknowledge(id: string): void {
    this.#ensureTables();
    this.#write(
      `UPDATE cf_agents_decisions SET acknowledged = 1
       WHERE id = ? AND status = 'settled'`,
      [id]
    );
  }

  /**
   * Delete expired rows: recorded and unfinished effects, decisions nobody
   * made, and acknowledged decisions, each past its retention. Runs at most
   * once an hour unless `force` is set. A decided decision is never swept.
   */
  async sweep(options: { force?: boolean } = {}): Promise<{
    effects: number;
    decisions: number;
  }> {
    this.#ensureTables();
    const storage = this.lifecycle.storage;
    const now = Date.now();
    if (!options.force) {
      const last = (await storage.get<number>(LAST_SWEPT_KEY)) ?? 0;
      if (now - last < SWEEP_INTERVAL_MS) return { effects: 0, decisions: 0 };
    }
    const retention = { ...DEFAULT_RETENTION, ...this.#options.retention?.() };
    const limit = Math.max(0, Math.floor(retention.maxSweepRows));
    let effects = this.#sweepRows(
      "cf_agents_effects",
      "key",
      "status = 'settled'",
      "updated_at",
      retention.effectSettledMs,
      now,
      limit
    );
    effects += this.#sweepRows(
      "cf_agents_effects",
      "key",
      "status = 'pending'",
      "updated_at",
      retention.effectPendingMs,
      now,
      limit - effects
    );
    let decisions = this.#sweepRows(
      "cf_agents_decisions",
      "id",
      "status = 'pending'",
      "created_at",
      retention.decisionPendingMs,
      now,
      limit
    );
    decisions += this.#sweepRows(
      "cf_agents_decisions",
      "id",
      "status = 'settled' AND acknowledged = 1",
      "settled_at",
      retention.decisionSettledMs,
      now,
      limit - decisions
    );
    await storage.put(LAST_SWEPT_KEY, now);
    if (effects > 0 || decisions > 0) {
      this.#emit("approvals:swept", { effects, decisions });
    }
    return { effects, decisions };
  }

  /**
   * @internal Import records a host wrote in its own tables before this
   * capability existed. Existing keys and ids are kept as they are.
   */
  importRecords(records: {
    effects?: readonly ImportedEffect[];
    decisions?: readonly ImportedDecision[];
  }): void {
    this.#ensureTables();
    for (const effect of records.effects ?? []) {
      this.#write(
        `INSERT OR IGNORE INTO cf_agents_effects
           (key, name, input_hash, status, result_json, context_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          effect.key,
          effect.name,
          effect.inputHash,
          effect.status,
          effect.resultJson,
          toJson(effect.context, "context"),
          effect.createdAt,
          effect.updatedAt
        ]
      );
    }
    for (const decision of records.decisions ?? []) {
      this.#write(
        `INSERT OR IGNORE INTO cf_agents_decisions
           (id, kind, subject_json, descriptor_json, status, verdict_json,
            outcome_json, attempts, acknowledged, created_at, decided_at, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
        [
          decision.id,
          decision.kind,
          toJson(decision.subject, "subject") ?? "null",
          toJson(decision.descriptor, "descriptor"),
          decision.status,
          toJson(decision.verdict, "verdict"),
          toJson(decision.outcome, "outcome"),
          decision.createdAt,
          decision.status === "settled"
            ? (decision.settledAt ?? decision.createdAt)
            : null,
          decision.status === "settled"
            ? (decision.settledAt ?? decision.createdAt)
            : null
        ]
      );
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Run a decided record's continuation once in this isolate. */
  #continue(id: string, delivery: { redelivered: boolean }): Promise<Decision> {
    const running = this.#runningDecisions.get(id);
    if (running) return running;
    const work = (async (): Promise<Decision> => {
      const row = this.#readDecision(id);
      if (!row) throw new Error(`Approvals: no decision "${id}"`);
      if (row.status === "settled") return this.#toDecision(row);
      const decision = this.#toDecision(row);
      let outcomeJson: string | null;
      try {
        const onDecided = this.#options.onDecided;
        const outcome = onDecided
          ? await this.lifecycle.runInHostContext(() => onDecided(decision))
          : undefined;
        outcomeJson = toJson(outcome, "outcome");
      } catch (error) {
        const attempts = row.attempts + 1;
        if (attempts < MAX_CONTINUATION_ATTEMPTS) {
          this.#write(
            "UPDATE cf_agents_decisions SET attempts = ? WHERE id = ?",
            [attempts, id]
          );
          this.#emit("approvals:decision:failed", {
            id,
            kind: row.kind,
            attempts,
            error: errorMessage(error)
          });
          throw error;
        }
        this.#write(
          `UPDATE cf_agents_decisions
           SET status = 'settled', error = ?, attempts = ?, settled_at = ?
           WHERE id = ? AND status = 'decided'`,
          [errorMessage(error), attempts, Date.now(), id]
        );
        return this.#afterSettle(id, row.kind, delivery);
      }
      try {
        this.#write(
          `UPDATE cf_agents_decisions
           SET status = 'settled', outcome_json = ?, settled_at = ?
           WHERE id = ? AND status = 'decided'`,
          [outcomeJson, Date.now(), id]
        );
      } catch (error) {
        // An outcome SQLite will not store (past its 2 MB row limit) fails
        // the same way on every run: settle with the error instead.
        this.#write(
          `UPDATE cf_agents_decisions
           SET status = 'settled', error = ?, settled_at = ?
           WHERE id = ? AND status = 'decided'`,
          [
            `The outcome could not be stored: ${errorMessage(error)}`,
            Date.now(),
            id
          ]
        );
      }
      return this.#afterSettle(id, row.kind, delivery);
    })();
    this.#runningDecisions.set(id, work);
    const forget = () => {
      if (this.#runningDecisions.get(id) === work) {
        this.#runningDecisions.delete(id);
      }
    };
    work.then(forget, forget);
    return work;
  }

  async #afterSettle(
    id: string,
    kind: string,
    delivery: { redelivered: boolean }
  ): Promise<Decision> {
    const row = this.#readDecision(id);
    if (!row) throw new Error(`Approvals: no decision "${id}"`);
    const decision = this.#toDecision(row);
    // Keep a wake while the outcome is handed off: a reset during it hands
    // it off again. Cancelled once the hand-off returns, so an outcome the
    // host chose to take up later is not handed off again and again.
    await this.#pushResume(id, Date.now() + this.#resumeAfterMs());
    this.#emit("approvals:decision:settled", {
      id,
      kind,
      ...(decision.error !== undefined && { error: decision.error })
    });
    for (const waiter of [...(this.#waiters.get(id) ?? [])]) {
      waiter.done(decision);
    }
    try {
      await this.#settle(decision, delivery);
    } catch (error) {
      // The outcome is recorded; only the hand-off failed. The job stays due
      // and hands it off again.
      console.error(`[Approvals] Hand-off of "${id}" failed:`, error);
      return this.get(id) ?? decision;
    }
    if (this.#canWake()) await this.lifecycle.jobs.cancel(resumeJobId(id));
    return this.get(id) ?? decision;
  }

  /** Hand a settled outcome to the host; without a handler it is acknowledged. */
  async #settle(
    decision: Decision,
    delivery: { redelivered: boolean }
  ): Promise<void> {
    const onSettled = this.#options.onSettled;
    if (!onSettled) {
      this.acknowledge(decision.id);
      return;
    }
    await this.lifecycle.runInHostContext(() =>
      onSettled(decision, { redelivered: delivery.redelivered })
    );
  }

  /**
   * Whether this object can wake itself. A routed sub-agent (a facet) has
   * no alarm of its own, so it keeps no recovery jobs, and an unfinished
   * decision there is not resumed after a reset.
   */
  #canWake(): boolean {
    return this.lifecycle.routes.source === undefined;
  }

  async #pushResume(id: string, time: number): Promise<void> {
    if (!this.#canWake()) return;
    await this.lifecycle.jobs.push({
      id: resumeJobId(id),
      fn: RESUME_FN,
      time,
      payload: { id }
    });
  }

  #resumeAfterMs(): number {
    return this.#options.resumeAfterMs ?? DEFAULT_RESUME_AFTER_MS;
  }

  /**
   * Delete up to `limit` rows matching `where` whose `timeColumn` is older
   * than the retention, oldest first. Returns how many were deleted.
   */
  #sweepRows(
    table: "cf_agents_effects" | "cf_agents_decisions",
    keyColumn: "key" | "id",
    where: string,
    timeColumn: string,
    retentionMs: number | false,
    now: number,
    limit: number
  ): number {
    if (retentionMs === false || limit <= 0) return 0;
    const query = `SELECT ${keyColumn} AS k FROM ${table}
      WHERE ${where} AND ${timeColumn} < ?
      ORDER BY ${timeColumn} ASC LIMIT ?`;
    let keys: string[];
    try {
      keys = [
        ...this.lifecycle.storage.sql.exec<{ k: string }>(
          query,
          now - retentionMs,
          limit
        )
      ].map((row) => row.k);
    } catch (cause) {
      throw new SqlError(query, cause);
    }
    let deleted = 0;
    for (const key of keys) {
      // A claim this isolate is still running is live, however old.
      if (table === "cf_agents_effects" && this.#runningEffects.has(key)) {
        continue;
      }
      this.#write(`DELETE FROM ${table} WHERE ${keyColumn} = ?`, [key]);
      deleted += 1;
      if (table === "cf_agents_decisions") {
        for (const waiter of [...(this.#waiters.get(key) ?? [])]) {
          waiter.fail(new Error(`Approvals: decision "${key}" expired`));
        }
      }
    }
    return deleted;
  }

  #readEffect(key: string): EffectRow | undefined {
    return this.#sql<EffectRow>`
      SELECT * FROM cf_agents_effects WHERE key = ${key}
    `[0];
  }

  #releaseEffect(key: string): void {
    this.#write("DELETE FROM cf_agents_effects WHERE key = ?", [key]);
  }

  #readDecision(id: string): DecisionRow | undefined {
    return this.#sql<DecisionRow>`
      SELECT * FROM cf_agents_decisions WHERE id = ${id}
    `[0];
  }

  #toDecision(row: DecisionRow): Decision {
    return {
      id: row.id,
      kind: row.kind,
      subject: parseJson(row.subject_json),
      descriptor: parseJson(row.descriptor_json),
      status: row.status,
      verdict: parseJson(row.verdict_json) as Verdict | undefined,
      outcome: parseJson(row.outcome_json),
      error: row.error ?? undefined,
      acknowledged: row.acknowledged === 1,
      createdAt: row.created_at,
      decidedAt: row.decided_at ?? undefined,
      settledAt: row.settled_at ?? undefined
    };
  }

  #ensureTables(): void {
    if (this.#tablesEnsured) return;
    const sql = this.lifecycle.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS cf_agents_effects (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        context_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE INDEX IF NOT EXISTS cf_agents_effects_sweep
      ON cf_agents_effects (status, updated_at)
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS cf_agents_decisions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject_json TEXT NOT NULL,
        descriptor_json TEXT,
        status TEXT NOT NULL,
        verdict_json TEXT,
        outcome_json TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        acknowledged INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        decided_at INTEGER,
        settled_at INTEGER
      )
    `);
    sql.exec(`
      CREATE INDEX IF NOT EXISTS cf_agents_decisions_status
      ON cf_agents_decisions (status, created_at)
    `);
    this.#tablesEnsured = true;
  }

  #sql<T>(strings: TemplateStringsArray, ...values: SqlValue[]): T[] {
    const query = strings.reduce(
      (result, part, index) =>
        result + part + (index < values.length ? "?" : ""),
      ""
    );
    try {
      // SAFETY: every query selects from this capability's own tables; T
      // names the projected columns.
      return [...this.lifecycle.storage.sql.exec(query, ...values)] as T[];
    } catch (cause) {
      throw new SqlError(query, cause);
    }
  }

  #write(query: string, params: SqlValue[]): number {
    try {
      return this.lifecycle.storage.sql.exec(query, ...params).rowsWritten;
    } catch (cause) {
      throw new SqlError(query, cause);
    }
  }

  #emit(type: ApprovalsEventType, payload: Record<string, unknown>): void {
    this.lifecycle.events.emit(type, payload);
  }
}
