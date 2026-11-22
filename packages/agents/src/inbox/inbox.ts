/**
 * Inbox: one durable record for every request waiting to run.
 *
 * A request is a row: its kind (the handler that runs it), its lane, its
 * payload, and where it is. Requests in one lane run one at a time in
 * arrival order; lanes run side by side. The record outlives the isolate: a
 * reset replays the lane from its rows, and a request that was running when
 * the isolate died runs again with the next attempt number. Handlers
 * therefore run at least once, not exactly once.
 *
 * The Lifecycle job queue holds one job per lane with an open request. It
 * is written with the request, so it is the wake that survives the isolate.
 * While a handler runs it moves 30 seconds ahead each time it fires, so it
 * also keeps the object awake and keeps long handlers inside the alarm
 * memory-limit breaker.
 *
 * In memory: the lane runners, the running handlers' abort controllers,
 * local values, debounce timers, held lanes and `wait()` promises.
 */

import {
  LifecycleCapability,
  type LifecycleServices
} from "../lifecycle/capability";
import type {
  LifecycleJobContext,
  LifecycleJobOutcome
} from "../lifecycle/job-queue";
import { stableStringify } from "../approvals/hash";
import { isPlatformFailure } from "../retries";
import { arrival, normalizePolicy } from "./policy";
import { INBOX_METADATA_LIMIT, InboxStore, type InboxRow } from "./store";
import type {
  InboxCancelResult,
  InboxEventType,
  InboxHandlers,
  InboxImport,
  InboxListOptions,
  InboxPayload,
  InboxPurgeOptions,
  InboxRequest,
  InboxRun,
  InboxStatus,
  InboxSubmitOptions,
  InboxSubmitResult,
  InboxTerminalStatus
} from "./types";

/** How far ahead a lane's wake moves while a handler runs. */
const HEARTBEAT_MS = 30_000;
/** Job ids are one space across capabilities, so they carry the inbox's id. */
const LANE_JOB_PREFIX = "lane:";
const DRAIN_FN = "drain";
const REPORT_FN = "report";
const REPORT_JOB = "report";
/** Terminal reports a reset left behind, replayed per batch. */
const REPORT_BATCH = 50;
/** Ids deleted per batch by `purgeBefore`. */
const PURGE_BATCH = 100;
const DEFAULT_MAX_ATTEMPTS = 3;

/** Options for an {@link Inbox}. */
export interface InboxOptions<Handlers extends InboxHandlers> {
  /**
   * The handler for each kind of request, called with the payload and the
   * run. Register them in a field initializer so they exist on every wake.
   * A handler runs at least once: after an interruption it runs again with
   * `run.attempt` above 1.
   *
   * Return the result, throw to end `error`, or return one of
   * {@link Inbox.aborted}, {@link Inbox.skipped}, {@link Inbox.failed},
   * {@link Inbox.detached}.
   */
  readonly handlers: Handlers;
  /**
   * Called on every status change, `pending` included, in the host's
   * context. Awaited: a lane does not move on, and `wait()` does not
   * resolve, until it returns. Errors are logged. The call for a terminal
   * status is repeated after a reset that cut it short.
   */
  readonly onStatus?: (request: InboxRequest) => void | Promise<void>;
  /** Runs an interrupted request may have before it ends `error`. Default 3. */
  readonly maxAttempts?: number;
  /**
   * A name for a second inbox on the same object, such as one a library
   * installs beside the app's: its rows live in `cf_agents_inbox__<name>`
   * and never meet another inbox's. Lowercase letters and digits.
   */
  readonly name?: string;
  /**
   * Keep terminal records until `delete()` or `purgeBefore()` (the
   * default). With `false` a record is deleted once its terminal `onStatus`
   * returned and its waiters were answered; a later submit with the same
   * id or idempotency key is then a new request.
   */
  readonly retain?: boolean;
}

/** How a handler, or {@link Inbox.settle}, ends a request. */
export class InboxSettlement {
  /** @internal Use the static helpers on {@link Inbox}. */
  constructor(
    readonly status: InboxTerminalStatus | "detached",
    readonly result: unknown,
    readonly reason: string | undefined
  ) {}
}

type Lane = {
  promise: Promise<void>;
  /** Wakes the runner from a wait, so it reads the lane again. */
  wake: (() => void) | null;
};

type LiveRun = {
  readonly controller: AbortController;
  readonly token: string;
};

/** A `wait()` on one record: a later record under the same id is another. */
type Waiter = {
  readonly token: string;
  readonly resolve: (request: InboxRequest | undefined) => void;
};

const OPEN: ReadonlySet<InboxStatus> = new Set(["pending", "running"]);

/**
 * Durable requests for a Lifecycle Object. Install with `Lifecycle.use()`.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class Inbox<
  Handlers extends InboxHandlers = InboxHandlers
> extends LifecycleCapability {
  /** End a request `completed` with `result`. */
  static completed(result?: unknown): InboxSettlement {
    return new InboxSettlement("completed", result, undefined);
  }
  /** End a request `error`. */
  static failed(error: unknown): InboxSettlement {
    return new InboxSettlement("error", undefined, reasonOf(error));
  }
  /** End a request `aborted`. */
  static aborted(reason?: unknown): InboxSettlement {
    return new InboxSettlement("aborted", undefined, reasonOf(reason));
  }
  /** End a request `skipped`. */
  static skipped(reason?: unknown): InboxSettlement {
    return new InboxSettlement("skipped", undefined, reasonOf(reason));
  }
  /**
   * Leave a request `running` and free its lane. It is never run again;
   * something else ends it with {@link Inbox.settle}.
   */
  static detached(): InboxSettlement {
    return new InboxSettlement("detached", undefined, undefined);
  }

  readonly #handlers: InboxHandlers;
  readonly #onStatus: InboxOptions<Handlers>["onStatus"];
  readonly #maxAttempts: number;
  readonly #name: string | undefined;
  readonly #retain: boolean;
  #store: InboxStore | undefined;
  readonly #lanes = new Map<string, Lane>();
  /** Running handlers, by request id. */
  readonly #live = new Map<string, LiveRun>();
  readonly #waiters = new Map<string, Set<Waiter>>();
  /** Reports in flight, by record token. */
  readonly #reporting = new Map<string, number>();
  /** What submits in this isolate attached to their records, by token. */
  readonly #locals = new Map<string, unknown>();
  /** Lanes whose requests from an earlier isolate wait. */
  readonly #held = new Set<string>();
  /**
   * Reports started outside a lane's runner (a submit's `pending`, a
   * cancel's terminal one). The runner waits for them before it reads the
   * lane again, so a handler never starts before its request's report
   * returned, nor after a cancelled request's report began.
   */
  readonly #barriers = new Map<string, Set<Promise<unknown>>>();
  /** The replay of unreported terminal reports, while one runs. */
  #replaying: Promise<void> | null = null;

  constructor(options: InboxOptions<Handlers>) {
    if (options.name !== undefined && !/^[a-z][a-z0-9]*$/.test(options.name)) {
      throw new Error(
        `Inbox names are lowercase letters and digits: ${JSON.stringify(options.name)}`
      );
    }
    super(options.name === undefined ? "inbox" : `inbox:${options.name}`);
    this.#name = options.name;
    this.#retain = options.retain ?? true;
    this.#handlers = options.handlers;
    this.#onStatus = options.onStatus;
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("Inbox maxAttempts must be an integer >= 1");
    }
    this.#maxAttempts = maxAttempts;
  }

  get #services(): LifecycleServices {
    return this.lifecycle;
  }

  /**
   * Whether the Lifecycle still has to start. A call made before it starts
   * waits for it, which also wakes the lanes a reset left open. Once it has
   * started, calls do not await before their writes, so the writes commit
   * with whatever the caller wrote in the same synchronous block.
   */
  #notStarted(): boolean {
    return this.#services.status() !== "started";
  }

  get #rows(): InboxStore {
    this.#store ??= new InboxStore(this.#services.storage, this.#name);
    return this.#store;
  }

  // ── Lifecycle hooks ──────────────────────────────────────────────────

  /**
   * Wake every lane an earlier isolate left open, and replay the terminal
   * reports a reset cut short.
   */
  async onStart(): Promise<void> {
    for (const lane of this.#rows.openLanes()) {
      await this.#pushWake(lane, Date.now());
    }
    if (this.#rows.unreported(1).length > 0) await this.#pushReportJob();
  }

  /** A lane's wake fired: run the lane, or keep it running. */
  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    const { job } = context;
    if (job.fn === REPORT_FN) {
      // The reports run user code, so they leave the job loop. The job
      // stays, 30 seconds out, until the replay found nothing left: a reset
      // during it still wakes the object to finish.
      this.#replaying ??= this.#replayReports().finally(() => {
        this.#replaying = null;
      });
      this.#services.trackAlarmWork(this.#replaying);
      return { rescheduleAt: Date.now() + HEARTBEAT_MS };
    }
    const lane = laneOfJob(job.payload);
    if (job.fn !== DRAIN_FN || lane === undefined) return undefined;
    if (!this.#lanes.has(lane) && !this.#rows.busy(lane)) return undefined;
    this.#services.trackAlarmWork(this.#startLane(lane));
    return { rescheduleAt: Date.now() + HEARTBEAT_MS };
  }

  /** Abort every running handler. */
  dispose(): void {
    for (const run of this.#live.values()) {
      run.controller.abort(new Error("The inbox was disposed"));
    }
    for (const lane of this.#lanes.values()) lane.wake?.();
  }

  // ── API ──────────────────────────────────────────────────────────────

  /**
   * Record a request. Once the Lifecycle has started, the row and its
   * lane's wake are written before this method first awaits, so a caller
   * can pair them with its own writes in one synchronous block.
   *
   * A submit whose id or idempotency key matches a record returns that
   * record with `accepted: false` when the kind and payload are the same,
   * and throws when they are not.
   */
  async submit<Kind extends keyof Handlers & string>(
    kind: Kind,
    payload: InboxPayload<Handlers[Kind]>,
    options: InboxSubmitOptions = {}
  ): Promise<InboxSubmitResult> {
    if (this.#notStarted()) await this.#services.ready();
    if (!Object.hasOwn(this.#handlers, kind)) {
      throw new Error(`Unknown inbox kind ${JSON.stringify(kind)}`);
    }
    if (options.id !== undefined && options.id.trim() === "") {
      throw new Error("Inbox request ids must be non-empty");
    }
    const metadata = metadataJson(options.metadata);
    const payloadJson = payload === undefined ? null : JSON.stringify(payload);
    const rows = this.#rows;

    const byId = options.id !== undefined ? rows.get(options.id) : undefined;
    const byKey =
      options.idempotencyKey !== undefined
        ? rows.byIdempotencyKey(options.idempotencyKey)
        : undefined;
    if (
      (byId && byKey && byId.request.id !== byKey.request.id) ||
      (byKey && options.id !== undefined && byKey.request.id !== options.id) ||
      (byId &&
        options.idempotencyKey !== undefined &&
        byId.request.idempotencyKey !== undefined &&
        byId.request.idempotencyKey !== options.idempotencyKey)
    ) {
      throw new Error("The id and idempotency key name different requests");
    }
    const existing = byId ?? byKey;
    if (existing) {
      if (
        existing.request.kind !== kind ||
        !samePayload(rows.payloadJson(existing.request.id), payloadJson)
      ) {
        throw new Error(
          `Inbox request ${JSON.stringify(existing.request.id)} exists with a different ${
            existing.request.kind !== kind ? "kind" : "payload"
          }`
        );
      }
      // A lost wake is found again by submitting the same request.
      if (OPEN.has(existing.request.status) && !existing.request.detached) {
        this.#kick(existing.request.lane, options.start ?? "alarm");
      }
      return { request: existing.request, accepted: false };
    }

    const lane = options.lane ?? kind;
    const policy = normalizePolicy(options.policy);
    const { overlap, dropped } = arrival(policy, rows.busy(lane));
    const now = Date.now();
    const id = options.id ?? crypto.randomUUID();
    const token = crypto.randomUUID();
    rows.insert({
      id,
      token,
      kind,
      lane,
      status: dropped ? "skipped" : "pending",
      idempotencyKey: options.idempotencyKey ?? null,
      payload: payloadJson,
      metadata,
      policy: policy.name,
      overlap,
      debounceUntil:
        overlap && policy.debounceMs !== null ? now + policy.debounceMs : null,
      error: dropped ? "dropped: the lane was busy" : null,
      now
    });
    if (options.local !== undefined) this.#locals.set(token, options.local);
    const start = options.start ?? "alarm";
    // The wake is durable with the row: a reset during the pending report
    // below still runs the request.
    if (!dropped) {
      void this.#pushWake(lane, start === "alarm" ? now : now + HEARTBEAT_MS);
    }
    const request = this.#read(id);
    this.#emit("inbox:submit", {
      id,
      kind,
      lane,
      idempotencyKey: options.idempotencyKey
    });
    if (dropped) {
      await this.#afterTerminal(request, token);
    } else {
      await this.#outsideRunner(lane, this.#notify(request));
      if (start === "now") this.#kick(lane, "now");
      else this.#lanes.get(lane)?.wake?.();
    }
    return { request: this.#rows.get(id)?.request ?? request, accepted: true };
  }

  /** One request, without its payload. */
  get(id: string): InboxRequest | undefined {
    if (!this.#rows.exists()) return undefined;
    return this.#rows.get(id)?.request;
  }

  /** A request's payload, or `undefined` when there is none. */
  payload<T = unknown>(id: string): T | undefined {
    if (!this.#rows.exists()) return undefined;
    const json = this.#rows.payloadJson(id);
    return json === null ? undefined : (JSON.parse(json) as T);
  }

  /** Requests, newest first unless `order: "oldest"`. */
  list(options?: InboxListOptions): InboxRequest[] {
    if (!this.#rows.exists()) return [];
    return this.#rows.list(options);
  }

  /**
   * Resolve once the request is terminal and its terminal `onStatus` has
   * returned, with the record; at once for a request that already is, and
   * with `undefined` for an unknown id. With `timeoutMs`, resolve with the
   * record as it is then. An aborted `signal` rejects with its reason.
   *
   * The wait lives in this isolate's memory. The record does not: after a
   * reset, call it again to keep waiting.
   */
  async wait(
    id: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<InboxRequest | undefined> {
    if (this.#notStarted()) await this.#services.ready();
    const row = this.#rows.exists() ? this.#rows.get(id) : undefined;
    if (!row) return undefined;
    if (this.#settled(row)) return row.request;
    const { signal, timeoutMs } = options;
    if (signal?.aborted) throw signal.reason;
    // A terminal record a reset left unreported waits for its replay.
    if (!OPEN.has(row.request.status) && !this.#reporting.has(row.token)) {
      void this.#pushReportJob();
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const waiters = this.#waiters.get(id);
        waiters?.delete(waiter);
        if (waiters?.size === 0) this.#waiters.delete(id);
      };
      const waiter: Waiter = {
        token: row.token,
        resolve: (request) => {
          done();
          resolve(request);
        }
      };
      const onAbort = () => {
        done();
        reject(signal?.reason);
      };
      let waiters = this.#waiters.get(id);
      if (!waiters) {
        waiters = new Set();
        this.#waiters.set(id, waiters);
      }
      waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          done();
          resolve(this.get(id));
        }, timeoutMs);
      }
    });
  }

  /**
   * Whether `wait()` would resolve at once: the request is terminal and its
   * terminal `onStatus` has returned.
   */
  isSettled(id: string): boolean {
    const row = this.#rows.exists() ? this.#rows.get(id) : undefined;
    return row !== undefined && this.#settled(row);
  }

  /**
   * Cancel a request. A pending one ends `aborted`; a running one ends
   * `aborted` and its signal aborts with `reason`. Its handler's later
   * return changes nothing. A terminal one is left alone.
   */
  async cancel(
    id: string,
    reason?: unknown
  ): Promise<InboxCancelResult | undefined> {
    if (this.#notStarted()) await this.#services.ready();
    const row = this.#rows.exists() ? this.#rows.get(id) : undefined;
    if (!row) return undefined;
    const { request } = row;
    if (!OPEN.has(request.status)) return { previous: request.status, request };
    const settled = this.#rows.settle(
      row.token,
      "aborted",
      { error: errorText(reasonOf(reason)), now: Date.now() },
      { from: "open" }
    );
    const ended = this.#read(id);
    if (!settled) return { previous: ended.status, request: ended };
    const report = this.#outsideRunner(
      request.lane,
      this.#afterTerminal(ended, row.token)
    );
    this.#abortLive(id, row.token, reason);
    this.#lanes.get(request.lane)?.wake?.();
    await report;
    return { previous: request.status, request: ended };
  }

  /**
   * End every open request of a lane `skipped`, detached ones included, and
   * abort the running handler's signal with `reason`. What is submitted
   * afterwards runs as usual, once that handler has returned.
   *
   * @returns The requests it ended, oldest first.
   */
  async clear(lane: string, reason?: unknown): Promise<InboxRequest[]> {
    if (this.#notStarted()) await this.#services.ready();
    const now = Date.now();
    const error = errorText(reasonOf(reason)) ?? "cleared";
    const ended: Array<{ request: InboxRequest; token: string }> = [];
    for (const { id, token } of this.#rows.openTokens(lane, {
      includeDetached: true
    })) {
      if (
        this.#rows.settle(token, "skipped", { error, now }, { from: "open" })
      ) {
        ended.push({ request: this.#read(id), token });
        // Every report is in flight from now, so a wait on the last one
        // holds while the first one runs.
        this.#holdReport(token);
      }
      this.#abortLive(id, token, reason);
    }
    const reports = (async () => {
      let next = 0;
      try {
        for (; next < ended.length; next++) {
          const { request, token } = ended[next];
          await this.#afterTerminal(request, token, true);
        }
      } finally {
        // A report that failed stops the rest. Theirs never started: release
        // them, and the replay reports them.
        for (let rest = next + 1; rest < ended.length; rest++) {
          const { request, token } = ended[rest];
          const count = (this.#reporting.get(token) ?? 1) - 1;
          if (count > 0) {
            this.#reporting.set(token, count);
          } else {
            this.#reporting.delete(token);
            this.#unreported(request, token);
          }
        }
      }
    })();
    this.#lanes.get(lane)?.wake?.();
    await this.#outsideRunner(lane, reports);
    return ended.map(({ request }) => request);
  }

  /**
   * End a running request from outside its handler: one a handler
   * {@link Inbox.detached}, or one whose outcome something else decided.
   * A handler still running for it is not aborted; its return changes
   * nothing.
   *
   * @returns Whether it ended the request.
   */
  async settle(id: string, outcome: InboxSettlement): Promise<boolean> {
    if (outcome.status === "detached") {
      throw new Error("settle() needs a terminal outcome");
    }
    if (this.#notStarted()) await this.#services.ready();
    const row = this.#rows.exists() ? this.#rows.get(id) : undefined;
    if (!row) return false;
    const write = (settlement: InboxSettlement) =>
      this.#rows.settle(
        row.token,
        settlement.status as InboxTerminalStatus,
        {
          result: resultJson(settlement),
          error: errorText(settlement.reason),
          now: Date.now()
        },
        { from: "running" }
      );
    let settled: boolean;
    try {
      settled = write(outcome);
    } catch (error) {
      if (isPlatformFailure(error)) throw error;
      settled = write(
        Inbox.failed(`The outcome could not be stored: ${reasonOf(error)}`)
      );
    } finally {
      resultJsons.delete(outcome);
    }
    if (!settled) return false;
    await this.#outsideRunner(
      row.request.lane,
      this.#afterTerminal(this.#read(id), row.token)
    );
    return true;
  }

  /**
   * Store what a handler wants a later attempt to know. Progress is notes,
   * not status: it can still be written after the request ended, for a
   * fact that lands late. `undefined` clears it.
   *
   * @returns Whether the request exists.
   */
  checkpoint(id: string, progress: unknown): boolean {
    if (!this.#rows.exists()) return false;
    return this.#rows.checkpoint(
      id,
      progress === undefined ? null : JSON.stringify(progress)
    );
  }

  /** Delete a terminal request. Returns false for an open or unknown one. */
  delete(id: string): boolean {
    const row = this.#rows.exists() ? this.#rows.get(id) : undefined;
    if (!row || !this.#rows.delete(id)) return false;
    // Its report already ran, or its waiters wake when it does.
    if (!this.#reporting.has(row.token)) this.#wake(row.token, row.request);
    return true;
  }

  /**
   * Delete terminal requests settled before `time` (epoch milliseconds),
   * the earliest settled first.
   *
   * @returns How many it deleted.
   */
  purgeBefore(time: number, options: InboxPurgeOptions = {}): number {
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    let deleted = 0;
    while (deleted < limit) {
      const ids = this.#rows.settledBefore(
        time,
        options,
        Math.min(PURGE_BATCH, limit - deleted)
      );
      if (ids.length === 0) break;
      let progressed = false;
      for (const id of ids) {
        if (this.delete(id)) {
          deleted++;
          progressed = true;
        }
      }
      if (!progressed) break;
    }
    return deleted;
  }

  /**
   * Write a record moved from another store, as it was. Nothing happens when
   * the id or idempotency key exists. An open record's lane is woken; a
   * `running` one counts as interrupted and runs again. A terminal record's
   * `onStatus` is not called: the store it came from already reported it.
   *
   * @returns Whether it wrote the record.
   */
  async import(record: InboxImport): Promise<boolean> {
    if (this.#notStarted()) await this.#services.ready();
    if (this.#rows.get(record.id)) return false;
    if (
      record.idempotencyKey !== undefined &&
      this.#rows.byIdempotencyKey(record.idempotencyKey)
    ) {
      return false;
    }
    this.#rows.restore(
      record,
      crypto.randomUUID(),
      record.metadata === undefined ? null : JSON.stringify(record.metadata)
    );
    if (OPEN.has(record.status)) {
      void this.#pushWake(record.lane ?? record.kind, Date.now());
    }
    return true;
  }

  /**
   * Hold a lane: requests an earlier isolate left in it wait, while
   * requests submitted in this isolate (with a `local` value) still run, in
   * order among themselves. A host holds a lane while work outside the
   * inbox must go first, such as a recovery the reset started.
   */
  hold(lane: string): void {
    this.#held.add(lane);
  }

  /** Let a held lane's waiting requests run, in order. */
  release(lane: string): void {
    if (!this.#held.delete(lane)) return;
    const running = this.#lanes.get(lane);
    if (running) running.wake?.();
    else if (this.#rows.busy(lane)) void this.#pushWake(lane, Date.now());
  }

  /** Whether a lane is held. */
  isHeld(lane: string): boolean {
    return this.#held.has(lane);
  }

  // ── Lanes ────────────────────────────────────────────────────────────

  /** Start an idle lane, or wake its runner to read the lane again. */
  #kick(lane: string, start: "alarm" | "now"): void {
    const running = this.#lanes.get(lane);
    if (running) {
      running.wake?.();
      return;
    }
    if (start === "now") {
      this.#startLane(lane).catch(() => {});
      return;
    }
    void this.#pushWake(lane, Date.now());
  }

  #laneJob(lane: string): string {
    return `${this.capabilityId}/${LANE_JOB_PREFIX}${lane}`;
  }

  #pushWake(lane: string, time: number): Promise<unknown> {
    return this.#services.jobs
      .push({
        id: this.#laneJob(lane),
        fn: DRAIN_FN,
        time,
        payload: { lane }
      })
      .catch((error: unknown) => {
        console.error(`[inbox] failed to wake lane ${lane}`, error);
      });
  }

  /** @param delayMs - After a failed report, wait before the replay. */
  #pushReportJob(delayMs = 0): Promise<unknown> {
    return this.#services.jobs
      .push({
        id: `${this.capabilityId}/${REPORT_JOB}`,
        fn: REPORT_FN,
        time: Date.now() + delayMs
      })
      .catch((error: unknown) => {
        console.error("[inbox] failed to queue status reports", error);
      });
  }

  /** Replay the terminal reports a reset cut short, a batch at a time. */
  async #replayReports(): Promise<void> {
    for (;;) {
      const batch = this.#rows
        .unreported(REPORT_BATCH)
        .filter(({ token }) => !this.#reporting.has(token));
      if (batch.length === 0) break;
      let reported = false;
      for (const { id, token } of batch) {
        // Read again: a report before this one may have deleted the record
        // or reused its id. Only the same record, still unreported, goes.
        const row = this.#rows.get(id);
        if (
          row?.token !== token ||
          OPEN.has(row.request.status) ||
          row.reported ||
          this.#reporting.has(token)
        ) {
          continue;
        }
        await this.#afterTerminal(row.request, token);
        reported = true;
      }
      if (!reported) break;
    }
    if (this.#rows.unreported(1).length === 0) {
      void this.#services.jobs
        .cancel(`${this.capabilityId}/${REPORT_JOB}`)
        .catch(() => {});
    }
  }

  /**
   * Run `work`, a report started outside the lane's runner, as a barrier
   * the runner waits for before it reads the lane again.
   */
  async #outsideRunner<T>(lane: string, work: Promise<T>): Promise<T> {
    let barriers = this.#barriers.get(lane);
    if (!barriers) {
      barriers = new Set();
      this.#barriers.set(lane, barriers);
    }
    const barrier = work.catch(() => {});
    barriers.add(barrier);
    try {
      return await work;
    } finally {
      barriers.delete(barrier);
      if (barriers.size === 0) this.#barriers.delete(lane);
    }
  }

  async #afterBarriers(lane: string): Promise<void> {
    for (;;) {
      const barriers = this.#barriers.get(lane);
      if (!barriers || barriers.size === 0) return;
      await Promise.all(barriers);
    }
  }

  #startLane(lane: string): Promise<void> {
    const running = this.#lanes.get(lane);
    if (running) return running.promise;
    const state: Lane = { promise: Promise.resolve(), wake: null };
    this.#lanes.set(lane, state);
    state.promise = this.#drive(lane, state);
    return state.promise;
  }

  /** Run a lane's requests one at a time until none is open. */
  async #drive(lane: string, state: Lane): Promise<void> {
    try {
      for (;;) {
        await this.#afterBarriers(lane);
        const next = this.#nextRunnable(lane);
        if (next === "held") {
          // Requests from an earlier isolate wait for release(). The wake
          // job stays, so a reset meanwhile still runs them.
          void this.#pushWake(lane, Date.now() + HEARTBEAT_MS);
          await new Promise<void>((resolve) => {
            state.wake = () => {
              state.wake = null;
              resolve();
            };
          });
          continue;
        }
        if (!next) {
          // Same synchronous block as the read: a submit cannot land in
          // between and lose its wake.
          if (this.#lanes.get(lane) === state) this.#lanes.delete(lane);
          void this.#services.jobs.cancel(this.#laneJob(lane)).catch(() => {});
          return;
        }
        await this.#step(state, next);
      }
    } catch (error) {
      if (this.#lanes.get(lane) === state) this.#lanes.delete(lane);
      // A platform failure (a memory-limit or code-update reset) is the
      // isolate's: the alarm breaker classifies it. The wake job is still
      // there and starts the lane again.
      if (isPlatformFailure(error)) throw error;
      console.error(`[inbox] lane ${lane} stopped`, error);
    }
  }

  /**
   * The request the lane runs next: the first open one, or, while the lane
   * is held, the first open one a submit in this isolate attached a local
   * value to. `"held"` when only requests from an earlier isolate are left.
   */
  #nextRunnable(lane: string): InboxRow | undefined | "held" {
    const next = this.#rows.nextOpen(lane);
    if (!next || !this.#held.has(lane) || this.#locals.has(next.token)) {
      return next;
    }
    for (const { id, token } of this.#rows.openTokens(lane, {
      includeDetached: false
    })) {
      if (this.#locals.has(token)) return this.#rows.get(id);
    }
    return "held";
  }

  async #step(state: Lane, row: InboxRow): Promise<void> {
    const { request, token } = row;
    if (request.status === "pending" && request.attempt >= this.#maxAttempts) {
      // A record another store reset to pending, its attempts spent.
      if (
        this.#rows.settle(
          token,
          "error",
          {
            error: `Interrupted ${request.attempt} time${request.attempt === 1 ? "" : "s"}`,
            now: Date.now()
          },
          { from: "pending" }
        )
      ) {
        await this.#afterTerminal(this.#read(request.id), token);
      }
      return;
    }
    if (request.status === "running") {
      // Only this runner starts runs in this lane, so a running row it
      // reads was interrupted: its isolate died.
      if (request.attempt >= this.#maxAttempts) {
        await this.#end(
          request.id,
          token,
          Inbox.failed(
            `Interrupted ${request.attempt} time${request.attempt === 1 ? "" : "s"}`
          ),
          request.attempt
        );
        return;
      }
      this.#emit("inbox:retry", {
        id: request.id,
        kind: request.kind,
        lane: request.lane,
        attempt: request.attempt + 1
      });
      await this.#execute(row, request.attempt + 1);
      return;
    }
    if (row.overlap) {
      const by = this.#rows.supersededBy(request.lane, request.seq);
      if (by !== undefined) {
        // The survivor keeps the list, so it outlives the skipped record.
        this.#rows.addMerged(by, [
          ...row.mergedEntries,
          { id: request.id, seq: request.seq }
        ]);
        if (
          this.#rows.settle(
            token,
            "skipped",
            { error: "superseded", now: Date.now() },
            { from: "pending" }
          )
        ) {
          await this.#afterTerminal(this.#read(request.id), token);
        }
        return;
      }
      const wait = (row.debounceUntil ?? 0) - Date.now();
      if (wait > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            state.wake = null;
            resolve();
          }, wait);
          state.wake = () => {
            clearTimeout(timer);
            state.wake = null;
            resolve();
          };
        });
        return;
      }
    }
    // A pending record can carry earlier attempts (an imported one).
    await this.#execute(row, request.attempt + 1);
  }

  async #execute(row: InboxRow, attempt: number): Promise<void> {
    const { request, token } = row;
    const now = Date.now();
    if (!this.#rows.start(token, attempt, now)) {
      // Another write changed the record since the runner read it. Yield
      // to the event loop before the runner reads the lane again, so a
      // record that cannot start never spins the isolate.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return;
    }
    const handler = this.#handlers[request.kind] as
      | ((payload: unknown, run: InboxRun) => unknown)
      | undefined;
    if (!handler) {
      await this.#end(
        request.id,
        token,
        Inbox.failed(
          `No handler for inbox kind ${JSON.stringify(request.kind)}`
        ),
        attempt
      );
      return;
    }
    const controller = new AbortController();
    this.#live.set(request.id, { controller, token });
    void this.#pushWake(request.lane, now + HEARTBEAT_MS);
    // The attempt must be durable before user code runs: a reset before the
    // next I/O rolls back unconfirmed writes, and a handler that kills its
    // isolate would then never use up its attempts.
    let outcome: InboxSettlement;
    try {
      await this.#services.storage.sync();
      // A cancel or clear while the attempt was written ended it already.
      if (!this.#rows.holds(token, attempt)) return;
      const started = this.#read(request.id);
      await this.#notify(started);
      // A cancel or clear during the report ended it already.
      if (!this.#rows.holds(token, attempt)) return;
      const run: InboxRun = {
        id: request.id,
        kind: request.kind,
        lane: request.lane,
        attempt,
        signal: controller.signal,
        ...(started.metadata !== undefined && { metadata: started.metadata }),
        ...(started.progress !== undefined && { progress: started.progress }),
        merged: this.#rows.get(request.id)?.merged ?? [],
        local: this.#locals.get(token)
      };
      try {
        const value = await this.#services.runInHostContext(() =>
          handler(this.payload(request.id), run)
        );
        outcome =
          value instanceof InboxSettlement ? value : Inbox.completed(value);
        // A result that cannot be stored is the handler's failure, decided
        // here, not a settle that throws and leaves the request running.
        // Serialized once: the stored JSON is this one.
        resultJson(outcome);
      } catch (error) {
        // The isolate is going: leave the request running for the next
        // attempt.
        if (isPlatformFailure(error)) throw error;
        outcome = Inbox.failed(error);
      }
    } finally {
      if (this.#live.get(request.id)?.controller === controller) {
        this.#live.delete(request.id);
      }
    }
    if (outcome.status === "detached") {
      this.#rows.detach(token, attempt);
      return;
    }
    await this.#end(request.id, token, outcome, attempt);
  }

  async #end(
    id: string,
    token: string,
    outcome: InboxSettlement,
    attempt: number
  ): Promise<void> {
    if (outcome.status === "detached") return;
    const write = (settlement: InboxSettlement) =>
      this.#rows.settle(
        token,
        settlement.status as InboxTerminalStatus,
        {
          result: resultJson(settlement),
          error: errorText(settlement.reason),
          now: Date.now()
        },
        { from: "running", attempt }
      );
    let settled: boolean;
    try {
      settled = write(outcome);
    } catch (error) {
      if (isPlatformFailure(error)) throw error;
      // The outcome could not be stored: end it `error`, never run again.
      settled = write(
        Inbox.failed(`The outcome could not be stored: ${reasonOf(error)}`)
      );
    } finally {
      // The JSON is this run's; a settlement reused later serializes again.
      resultJsons.delete(outcome);
    }
    if (settled) await this.#afterTerminal(this.#read(id), token);
  }

  // ── Status ───────────────────────────────────────────────────────────

  #settled(row: InboxRow): boolean {
    return row.reported && !this.#reporting.has(row.token);
  }

  /** Count a terminal report as in flight, so `wait()` holds until it ends. */
  #holdReport(token: string): void {
    this.#reporting.set(token, (this.#reporting.get(token) ?? 0) + 1);
  }

  /**
   * Report a terminal record, then wake its waiters.
   *
   * @param held - {@link #holdReport} already counted this report.
   */
  async #afterTerminal(
    request: InboxRequest,
    token: string,
    held = false
  ): Promise<void> {
    if (!held) this.#holdReport(token);
    let reported = false;
    try {
      await this.#notify(request);
      this.#rows.reported(token, request.status);
      reported = true;
    } finally {
      const count = (this.#reporting.get(token) ?? 1) - 1;
      if (count > 0) {
        this.#reporting.set(token, count);
      } else if (!reported) {
        this.#reporting.delete(token);
        this.#unreported(request, token);
      } else {
        this.#reporting.delete(token);
        this.#locals.delete(token);
        // A record deleted meanwhile still gives its waiters the record it
        // ended with. Waiters of a later record under the same id wait on
        // that one.
        const current = this.#rows.get(request.id);
        const same = current?.token === token;
        this.#wake(token, same ? current.request : request);
        if (!this.#retain && same) this.#rows.delete(request.id);
      }
    }
  }

  /**
   * A report that failed (a platform failure), or never started. The record
   * stays unreported for the replay, and its waiters keep waiting; a record
   * deleted meanwhile has no replay, so its waiters get what it ended with.
   */
  #unreported(request: InboxRequest, token: string): void {
    if (this.#rows.get(request.id)?.token === token) {
      void this.#pushReportJob(HEARTBEAT_MS);
      return;
    }
    this.#locals.delete(token);
    this.#wake(token, request);
  }

  /** Resolve the waiters of the record `token` names with `answer`. */
  #wake(token: string, answer: InboxRequest): void {
    for (const waiter of [...(this.#waiters.get(answer.id) ?? [])]) {
      if (waiter.token === token) waiter.resolve(answer);
    }
  }

  async #notify(request: InboxRequest): Promise<void> {
    this.#emit("inbox:status", {
      id: request.id,
      kind: request.kind,
      lane: request.lane,
      status: request.status,
      attempt: request.attempt
    });
    if (request.status === "error") {
      this.#emit("inbox:error", {
        id: request.id,
        kind: request.kind,
        lane: request.lane,
        error: request.error
      });
    }
    const onStatus = this.#onStatus;
    if (!onStatus) return;
    try {
      await this.#services.runInHostContext(() => onStatus(request));
    } catch (error) {
      if (isPlatformFailure(error)) throw error;
      console.error("[inbox] onStatus failed", error);
    }
  }

  /** Abort the handler running for the record `token` names, if any. */
  #abortLive(id: string, token: string, reason: unknown): void {
    const live = this.#live.get(id);
    if (live?.token !== token) return;
    if (reason === undefined) live.controller.abort();
    else live.controller.abort(reason);
  }

  #read(id: string): InboxRequest {
    const request = this.#rows.get(id)?.request;
    if (!request) throw new Error(`Inbox request ${id} is missing`);
    return request;
  }

  #emit(type: InboxEventType, payload: Record<string, unknown>): void {
    this.#services.events.emit(type, payload);
  }
}

/** Whether two payloads' JSON is the same value, whatever its key order. */
function samePayload(stored: string | null, submitted: string | null): boolean {
  if (stored === submitted) return true;
  if (stored === null || submitted === null) return false;
  try {
    return (
      stableStringify(JSON.parse(stored)) ===
      stableStringify(JSON.parse(submitted))
    );
  } catch {
    // Nested too deep to compare key by key: only the exact text matches.
    return false;
  }
}

function laneOfJob(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const lane = (payload as { lane?: unknown }).lane;
  return typeof lane === "string" ? lane : undefined;
}

function metadataJson(
  metadata: Record<string, unknown> | undefined
): string | null {
  if (metadata === undefined) return null;
  const json = JSON.stringify(metadata);
  if (json.length > INBOX_METADATA_LIMIT) {
    throw new Error(
      `Inbox metadata is limited to ${INBOX_METADATA_LIMIT} characters of JSON`
    );
  }
  return json;
}

function reasonOf(reason: unknown): string | undefined {
  if (reason === undefined) return undefined;
  if (reason instanceof Error) return reason.message;
  return typeof reason === "string" ? reason : String(reason);
}

/** The longest error text a record keeps. */
const ERROR_LIMIT = 10_000;

function errorText(reason: string | undefined): string | null {
  if (reason === undefined) return null;
  return reason.length > ERROR_LIMIT
    ? `${reason.slice(0, ERROR_LIMIT)}…`
    : reason;
}

/** Each settlement's result JSON, serialized once. */
const resultJsons = new WeakMap<InboxSettlement, string | null>();

function resultJson(outcome: InboxSettlement): string | null {
  if (resultJsons.has(outcome)) return resultJsons.get(outcome) ?? null;
  const json =
    outcome.status === "completed" && outcome.result !== undefined
      ? JSON.stringify(outcome.result)
      : null;
  resultJsons.set(outcome, json);
  return json;
}
