/**
 * The Harness capability: one developer API over a pluggable runtime.
 *
 * The base owns admission (a durable inbox), operation rows, request rows,
 * one Streams log per operation plus one per session, the Tasks driver that
 * wakes the runtime, and the browser transport. A `HarnessRuntime` owns the
 * agent loop and the user-visible transcript. Harnesses differ by runtime,
 * never by subclass.
 *
 * Storage rules: session state is derived from rows, never maintained; the
 * write-hot inbox has no index; a frame append is one row write per batch.
 */
import {
  LifecycleCapability,
  type CapabilityStartContext,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
  type MemoryLimitContext
} from "agents/lifecycle";
import type { StreamJson, Streams, StreamWriter } from "agents/streams";
import type { Tasks, TaskStep } from "agents/tasks";
import type { WebSocketsOptions } from "agents/websockets";
import { HarnessTransport } from "./transport";
import type {
  HarnessActiveOperation,
  HarnessDriveContext,
  HarnessFrame,
  HarnessInboxRow,
  HarnessOperationHandle,
  HarnessPolicy,
  HarnessRuntime,
  HarnessSettlement
} from "./runtime";
import {
  DEFAULT_SESSION_ID,
  HarnessBackpressureError,
  HarnessCapabilityUnsupportedError,
  HarnessClosedError,
  HarnessConflictError,
  HarnessDetachedError,
  HarnessOperationNotFoundError,
  HarnessSessionNotFoundError,
  HarnessTimeoutError,
  type HarnessCapability,
  type HarnessCompactOptions,
  type HarnessConfig,
  type HarnessConfigPatch,
  type HarnessCoreEvent,
  type HarnessEvent,
  type HarnessEventBody,
  type HarnessEventsOptions,
  type HarnessForkOptions,
  type HarnessInput,
  type HarnessInterruptOptions,
  type HarnessInterruptResult,
  type HarnessMessagePage,
  type HarnessMessagesOptions,
  type HarnessPreview,
  type HarnessPreviewBody,
  type HarnessPromptOptions,
  type HarnessProtocol,
  type HarnessReceipt,
  type HarnessReply,
  type HarnessRequest,
  type HarnessRequestDraft,
  type HarnessResult,
  type HarnessRewindOptions,
  type HarnessRewindResult,
  type HarnessRunState,
  type HarnessSession,
  type HarnessSessionCreateOptions,
  type HarnessSessionInfo,
  type HarnessSessionListOptions,
  type HarnessSessionPage,
  type HarnessSessions,
  type HarnessStatus,
  type HarnessSubmitOptions,
  type HarnessWaitOptions,
  type JsonValue
} from "./types";

export type HarnessOptions<P extends HarnessProtocol = HarnessProtocol> = {
  readonly tasks: Tasks;
  readonly streams: Streams;
  readonly runtime: HarnessRuntime<P>;
  /** Numbers and enums only. No callbacks, no adapters, no bindings. */
  readonly policy?: HarnessPolicy;
  /** Capability id, when one object installs more than one harness. Default `"harness"`. */
  readonly id?: string;
};

const RESERVED_KINDS = new Set(["prompt", "interrupt", "reply", "compact"]);
const DRIVE_FN = "drive";
const RECONCILE_FN = "reconcile";
const REQUEST_TIMEOUT_FN = "request-timeout";
const ROTATION_DELAY_MS = 2_000;
const ERROR_BACKOFF_BASE_MS = 1_000;
const ERROR_BACKOFF_MAX_MS = 5 * 60_000;
const RESULT_POLL_MS = 500;
const DEFAULT_MESSAGE_BYTES = 262_144;
const MAX_SESSION_ID_LENGTH = 128;
const SESSION_LIST_LIMIT = 100;
/** Live frames buffered for one slow `events()` consumer before it re-reads the log. */
const MAX_LIVE_QUEUE = 2000;

type BatchPolicy = Required<NonNullable<HarnessPolicy["batch"]>>;
type ResolvedPolicy = Omit<Required<HarnessPolicy>, "batch"> & {
  readonly batch: BatchPolicy;
};

const DEFAULT_POLICY: ResolvedPolicy = {
  batch: { ms: 100, frames: 64, bytes: 262_144 },
  inboxLimit: 1000,
  requestTimeoutMs: 600_000,
  rotateAfterPasses: 4000,
  maxPassFailures: 5
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cf_agents_harness_sessions (
  session_id TEXT PRIMARY KEY,
  title TEXT,
  parent_id TEXT,
  config TEXT,
  pruned_seq INTEGER,
  pruned_wire_seq INTEGER,
  pruned_runtime_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cf_agents_harness_inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  key TEXT NOT NULL,
  operation_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cf_agents_harness_operations (
  operation_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  kind TEXT NOT NULL,
  delivery TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  payload TEXT,
  runtime_id TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  settled_at INTEGER,
  first_seq INTEGER,
  last_seq INTEGER,
  result TEXT
);
CREATE TABLE IF NOT EXISTS cf_agents_harness_requests (
  request_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  asked_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

type SessionRow = {
  session_id: string;
  title: string | null;
  parent_id: string | null;
  config: string | null;
  created_at: number;
  updated_at: number;
};

type InboxRow = {
  seq: number;
  session_id: string;
  key: string;
  operation_id: string | null;
  kind: string;
  payload: string;
  created_at: number;
};

type OperationRow = {
  operation_id: string;
  session_id: string;
  status: "queued" | "running" | "settled";
  kind: string;
  delivery: "queue" | "steer";
  input_hash: string;
  payload: string | null;
  runtime_id: string | null;
  created_at: number;
  started_at: number | null;
  settled_at: number | null;
  first_seq: number | null;
  last_seq: number | null;
  result: string | null;
};

type RequestRow = {
  request_id: string;
  session_id: string;
  operation_id: string;
  type: string;
  payload: string;
  asked_at: number;
  expires_at: number;
};

type DriverInput = { readonly version: 1; readonly sessionId: string };

type LiveSubscriber = {
  readonly previews: boolean;
  frames(streamId: string, frames: readonly HarnessFrame[]): void;
  preview(preview: HarnessPreview): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDriverInput(value: unknown): DriverInput {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.sessionId !== "string"
  ) {
    throw new Error("Invalid harness driver input");
  }
  return { version: 1, sessionId: value.sessionId };
}

/** Stable JSON: object keys sorted, so equal inputs hash equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    isRecord(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]])
        )
      : item
  );
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Values Tasks throws through a handler to steer the run, and platform
 * failures the run must not settle on. `TaskSuspension` and
 * `TaskCancellation` are plain classes, not Errors; the rest are named.
 */
const PLATFORM_FAILURE_PATTERN =
  /reset because its code was updated|this script has been upgraded|network connection lost|Internal error in Durable Object storage caused object to be reset|exceeded the memory limit/i;

function isTaskControl(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  // agents/tasks does not export its control classes; they are plain
  // classes (not Errors) with stable names in the built package.
  const name = error.constructor?.name;
  if (name === "TaskSuspension" || name === "TaskCancellation") return true;
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AttemptSupersededError" ||
    PLATFORM_FAILURE_PATTERN.test(error.message)
  );
}

function errorBackoffMs(consecutive: number): number {
  return Math.min(
    ERROR_BACKOFF_MAX_MS,
    ERROR_BACKOFF_BASE_MS * 2 ** Math.max(0, consecutive - 1)
  );
}

function errorSummary(error: unknown): {
  readonly code: string;
  readonly message: string;
} {
  if (error instanceof Error) {
    const code =
      "code" in error && typeof error.code === "string"
        ? error.code
        : error.name;
    return { code, message: error.message };
  }
  return { code: "E_UNKNOWN", message: String(error) };
}

/** Tag every log of a session carries, and the tag its sockets carry. */
export function harnessSessionTag(sessionId: string): string {
  return `harness:${sessionId}`;
}

export function harnessOperationStreamId(
  sessionId: string,
  operationId: string
): string {
  return `harness:${sessionId}:${operationId}`;
}

export function harnessSessionStreamId(sessionId: string): string {
  return `harness:${sessionId}`;
}

/** Validate a caller-supplied session id. */
export function validateSessionId(sessionId: string): string {
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    sessionId.length > MAX_SESSION_ID_LENGTH ||
    /\s/.test(sessionId)
  ) {
    throw new HarnessSessionNotFoundError(String(sessionId));
  }
  return sessionId;
}

// ── Log writer ────────────────────────────────────────────────────────────

/**
 * One durable log (a Streams stream) with append batching. A frame is
 * stamped with the session seq when appended and becomes durable at flush:
 * live subscribers are notified only at flush, so a browser never sees a
 * seq the log did not keep.
 */
class LogWriter<
  P extends HarnessProtocol
> implements HarnessOperationHandle<P> {
  readonly streamId: string;
  readonly sessionId: string;
  readonly operationId: string | undefined;
  #writer: StreamWriter | undefined;
  #pending: HarnessFrame<P>[] = [];
  #pendingBytes = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  readonly #owner: HarnessLogOwner<P>;

  constructor(
    owner: HarnessLogOwner<P>,
    sessionId: string,
    operationId: string | undefined,
    streamId: string,
    writer: StreamWriter | undefined
  ) {
    this.#owner = owner;
    this.sessionId = sessionId;
    this.operationId = operationId;
    this.streamId = streamId;
    this.#writer = writer;
    if (!writer) this.#closed = true;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The seq of the oldest buffered frame, or undefined when nothing is pending. */
  get pendingFirstSeq(): number | undefined {
    return this.#pending[0]?.seq;
  }

  append(
    body: HarnessEventBody<P>,
    options?: { readonly wire?: HarnessFrame<P>["wire"] }
  ): number {
    if (this.#closed) {
      console.warn(
        `Harness log ${this.streamId} is settled; dropped ${body.type}`
      );
      return -1;
    }
    const frame: HarnessFrame<P> = {
      seq: this.#owner.nextSeq(this.sessionId),
      ...(this.operationId === undefined
        ? {}
        : { operationId: this.operationId }),
      body,
      ...(options?.wire === undefined ? {} : { wire: options.wire })
    };
    this.#pending.push(frame);
    this.#pendingBytes += JSON.stringify(body).length;
    const batch = this.#owner.batch;
    if (
      this.#pending.length >= batch.frames ||
      this.#pendingBytes >= batch.bytes
    ) {
      this.flush();
      return frame.seq;
    }
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      this.flush();
    }, batch.ms);
    return frame.seq;
  }

  preview(preview: HarnessPreviewBody): void {
    if (this.#closed) return;
    // Keep order: a delta never overtakes the frame appended before it.
    if (this.#pending.length > 0) this.flush();
    this.#owner.deliverPreview({
      preview: true,
      sessionId: this.sessionId,
      ...(this.operationId === undefined
        ? {}
        : { operationId: this.operationId }),
      body: preview
    });
  }

  /** Durably write the pending batch: exactly one row write. */
  flush(options?: { readonly commit?: () => void }): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const frames = this.#pending;
    this.#pending = [];
    this.#pendingBytes = 0;
    const writer = this.#writer;
    const commit = options?.commit;
    const write = () => {
      if (frames.length === 0 || !writer) return;
      // Subscribers see the session's frames in seq order even though each
      // log batches on its own: older frames buffered elsewhere land first.
      this.#owner.flushOlder(this.sessionId, frames[0].seq);
      // SAFETY: frames are plain JSON by construction (HarnessFrame).
      writer.append(frames as unknown as StreamJson);
    };
    if (commit) {
      // The runtime's own rows ride the same transaction as the frames.
      this.#owner.transaction(() => {
        write();
        commit();
      });
    } else {
      write();
    }
    if (frames.length > 0 && writer) {
      this.#owner.deliverFrames(this.sessionId, this.streamId, frames);
    }
  }

  /** Settle the underlying stream. Call inside the settle transaction. */
  settle(state: "completed" | "errored", reason?: string): void {
    this.flush();
    this.#closed = true;
    const writer = this.#writer;
    this.#writer = undefined;
    if (!writer) return;
    if (state === "completed") writer.close();
    else writer.error(reason);
  }
}

/** What a log writer needs from the capability. */
interface HarnessLogOwner<P extends HarnessProtocol> {
  readonly batch: BatchPolicy;
  nextSeq(sessionId: string): number;
  transaction(work: () => void): void;
  flushOlder(sessionId: string, beforeSeq: number): void;
  deliverFrames(
    sessionId: string,
    streamId: string,
    frames: readonly HarnessFrame<P>[]
  ): void;
  deliverPreview(preview: HarnessPreview): void;
}

// ── The capability ────────────────────────────────────────────────────────

/**
 * One concrete class. `new Harness({ tasks, streams, runtime })`, then
 * `harness.session().prompt("...")`.
 */
export class Harness<P extends HarnessProtocol = HarnessProtocol>
  extends LifecycleCapability
  implements HarnessLogOwner<P>
{
  readonly #tasks: Tasks;
  readonly #streams: Streams;
  readonly #runtime: HarnessRuntime<P>;
  readonly #policy: ResolvedPolicy;
  readonly batch: BatchPolicy;
  readonly #definition: string;

  /** Session seq counters, seeded lazily from the durable logs. */
  readonly #seq = new Map<string, number>();
  readonly #seeding = new Map<string, Promise<number>>();
  /** Open operation logs in this isolate, by operation id. */
  readonly #operationLogs = new Map<string, LogWriter<P>>();
  /** Open session logs in this isolate, by session id. */
  readonly #sessionLogs = new Map<string, LogWriter<P>>();
  readonly #subscribers = new Map<string, Set<LiveSubscriber>>();
  readonly #settlementWaiters = new Map<string, Set<() => void>>();
  readonly #askWaiters = new Map<
    string,
    { resolve(reply: HarnessReply): void; reject(error: unknown): void }
  >();
  readonly #interrupts = new Map<string, AbortController>();
  readonly #runStates = new Map<string, "running" | "retrying">();
  readonly #pendingWakes = new Map<string, number>();
  /** Runtimes awaiting a new inbox row for a session, in this isolate. */
  readonly #inboxWaiters = new Map<string, Set<() => void>>();
  readonly #driveControllers = new Set<AbortController>();
  readonly #ensuring = new Map<string, Promise<void>>();
  #transport: HarnessTransport<P> | undefined;
  #disposed = false;

  readonly sessions: HarnessSessions<P>;

  constructor(options: HarnessOptions<P>) {
    super(options.id ?? "harness");
    this.#tasks = options.tasks;
    this.#streams = options.streams;
    this.#runtime = options.runtime;
    const policy = options.policy ?? {};
    this.batch = {
      ms: policy.batch?.ms ?? DEFAULT_POLICY.batch.ms,
      frames: policy.batch?.frames ?? DEFAULT_POLICY.batch.frames,
      bytes: policy.batch?.bytes ?? DEFAULT_POLICY.batch.bytes
    };
    this.#policy = {
      batch: this.batch,
      inboxLimit: policy.inboxLimit ?? DEFAULT_POLICY.inboxLimit,
      requestTimeoutMs:
        policy.requestTimeoutMs ?? DEFAULT_POLICY.requestTimeoutMs,
      rotateAfterPasses:
        policy.rotateAfterPasses ?? DEFAULT_POLICY.rotateAfterPasses,
      maxPassFailures: policy.maxPassFailures ?? DEFAULT_POLICY.maxPassFailures
    };
    if (this.batch.bytes >= 1_048_576) {
      throw new Error("Harness policy.batch.bytes must stay below 1 MiB");
    }
    this.#definition = `__cf_harness@v1:${this.capabilityId}`;
    // Registered unconditionally, once per capability instance: an in-flight
    // driver run replays through this name after every wake.
    options.tasks.register(this.#definition, (input, step) =>
      this.#drive(parseDriverInput(input), step)
    );
    this.sessions = {
      create: (createOptions) => this.#createSession(createOptions),
      open: (sessionId) => this.session(sessionId),
      list: (listOptions) => this.#listSessions(listOptions),
      delete: (sessionId) => this.#deleteSession(sessionId)
    };
  }

  /** The runtime's capabilities. `status().capabilities` is the same set. */
  get capabilities(): ReadonlySet<HarnessCapability> {
    return this.#runtime.capabilities;
  }

  /** The runtime this harness drives. */
  get runtime(): HarnessRuntime<P> {
    return this.#runtime;
  }

  /** The Streams capability holding every log. */
  get streams(): Streams {
    return this.#streams;
  }

  /** A handle on one session. Synchronous, no I/O. */
  session(sessionId: string = DEFAULT_SESSION_ID): HarnessSession<P> {
    return new SessionHandle<P>(this, validateSessionId(sessionId));
  }

  /**
   * Options for a `WebSockets` capability serving the browser link:
   * `new WebSockets(this.harness.webSockets())`. Takes no arguments, ever.
   */
  webSockets(): WebSocketsOptions {
    this.#transport ??= new HarnessTransport<P>(this);
    this.#transport.bindSockets(() => this.lifecycle.sockets);
    return this.#transport.webSocketOptions();
  }

  // ── Lifecycle hooks ──────────────────────────────────────────────────────

  override async onStart(_context: CapabilityStartContext): Promise<void> {
    const storage = this.lifecycle.storage;
    storage.sql.exec(SCHEMA);
    await this.#runtime.onStart?.({
      storage,
      wake: (sessionId, afterMs) => void this.#wake(sessionId, afterMs ?? 0)
    });
    // Drivers are re-derived after startup completes so Tasks is ready no
    // matter the installation order.
    const sessions = new Set<string>([
      ...this.#sql<{ session_id: string }>(
        "SELECT DISTINCT session_id FROM cf_agents_harness_inbox"
      ).map((row) => row.session_id),
      ...this.#sql<{ session_id: string }>(
        "SELECT DISTINCT session_id FROM cf_agents_harness_operations WHERE status = 'running'"
      ).map((row) => row.session_id)
    ]);
    if (sessions.size === 0) return;
    await this.lifecycle.jobs.push({
      id: RECONCILE_FN,
      fn: RECONCILE_FN,
      time: Date.now(),
      payload: { sessions: [...sessions] }
    });
  }

  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    const payload = context.job.payload;
    switch (context.job.fn) {
      case RECONCILE_FN: {
        const sessions =
          isRecord(payload) && Array.isArray(payload.sessions)
            ? payload.sessions.filter((id) => typeof id === "string")
            : [];
        for (const sessionId of sessions) await this.#ensureDriver(sessionId);
        return;
      }
      case DRIVE_FN:
        if (isRecord(payload) && typeof payload.sessionId === "string") {
          await this.#ensureDriver(payload.sessionId);
        }
        return;
      case REQUEST_TIMEOUT_FN:
        if (isRecord(payload) && typeof payload.requestId === "string") {
          await this.#timeoutRequest(payload.requestId);
        }
        return;
      default:
        this.lifecycle.events.emit("harness:invalid_job", {
          jobId: context.job.id,
          fn: context.job.fn
        });
        return;
    }
  }

  async onMemoryLimit(_context: MemoryLimitContext): Promise<void> {
    this.#abortDrives("memory-limit");
    await this.#runtime.dispose?.("memory-limit");
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const writer of this.#operationLogs.values()) writer.flush();
    for (const writer of this.#sessionLogs.values()) writer.flush();
    this.#abortDrives("dispose");
    for (const waiter of this.#askWaiters.values()) {
      waiter.reject(new HarnessDetachedError("Harness disposed"));
    }
    this.#askWaiters.clear();
    await this.#runtime.dispose?.("dispose");
  }

  #abortDrives(reason: string): void {
    for (const controller of this.#driveControllers) {
      controller.abort(new HarnessDetachedError(reason));
    }
    this.#driveControllers.clear();
  }

  // ── SQL helpers ──────────────────────────────────────────────────────────

  #sql<Row extends Record<string, SqlStorageValue>>(
    query: string,
    ...params: (string | number | null)[]
  ): Row[] {
    return this.lifecycle.storage.sql.exec<Row>(query, ...params).toArray();
  }

  #sessionRow(sessionId: string): SessionRow | undefined {
    return this.#sql<SessionRow>(
      "SELECT * FROM cf_agents_harness_sessions WHERE session_id = ?",
      sessionId
    )[0];
  }

  #operationRow(operationId: string): OperationRow | undefined {
    return this.#sql<OperationRow>(
      "SELECT * FROM cf_agents_harness_operations WHERE operation_id = ?",
      operationId
    )[0];
  }

  #runningOperation(sessionId: string): OperationRow | undefined {
    return this.#sql<OperationRow>(
      `SELECT * FROM cf_agents_harness_operations
       WHERE session_id = ? AND status = 'running'
       ORDER BY started_at ASC LIMIT 1`,
      sessionId
    )[0];
  }

  #queuedOperations(sessionId: string): OperationRow[] {
    return this.#sql<OperationRow>(
      `SELECT * FROM cf_agents_harness_operations
       WHERE session_id = ? AND status = 'queued' ORDER BY created_at ASC`,
      sessionId
    );
  }

  #inboxRows(
    sessionId: string,
    kinds?: readonly string[],
    limit = 1000
  ): InboxRow[] {
    if (kinds && kinds.length > 0) {
      return this.#sql<InboxRow>(
        `SELECT * FROM cf_agents_harness_inbox
         WHERE session_id = ? AND kind IN (${kinds.map(() => "?").join(", ")})
         ORDER BY seq ASC LIMIT ?`,
        sessionId,
        ...kinds,
        limit
      );
    }
    return this.#sql<InboxRow>(
      `SELECT * FROM cf_agents_harness_inbox WHERE session_id = ?
       ORDER BY seq ASC LIMIT ?`,
      sessionId,
      limit
    );
  }

  #inboxCount(sessionId: string): number {
    return (
      this.#sql<{ n: number }>(
        "SELECT count(*) AS n FROM cf_agents_harness_inbox WHERE session_id = ?",
        sessionId
      )[0]?.n ?? 0
    );
  }

  #inboxHasKey(sessionId: string, key: string): boolean {
    return (
      this.#sql<{ seq: number }>(
        "SELECT seq FROM cf_agents_harness_inbox WHERE session_id = ? AND key = ? LIMIT 1",
        sessionId,
        key
      ).length > 0
    );
  }

  #insertInbox(row: {
    sessionId: string;
    key: string;
    operationId: string | null;
    kind: string;
    payload: unknown;
  }): number {
    this.lifecycle.storage.sql.exec(
      `INSERT INTO cf_agents_harness_inbox
         (session_id, key, operation_id, kind, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      row.sessionId,
      row.key,
      row.operationId,
      row.kind,
      JSON.stringify(row.payload ?? null),
      Date.now()
    );
    const seq =
      this.#sql<{ seq: number }>("SELECT last_insert_rowid() AS seq")[0]?.seq ??
      0;
    const waiters = this.#inboxWaiters.get(row.sessionId);
    if (waiters) {
      this.#inboxWaiters.delete(row.sessionId);
      for (const wake of waiters) wake();
    }
    return seq;
  }

  /** Resolve when the next row lands in the session's inbox. Peek first. */
  #awaitInbox(sessionId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let waiters = this.#inboxWaiters.get(sessionId);
      if (!waiters) {
        waiters = new Set();
        this.#inboxWaiters.set(sessionId, waiters);
      }
      const wake = () => {
        signal?.removeEventListener("abort", wake);
        waiters?.delete(wake);
        resolve();
      };
      signal?.addEventListener("abort", wake, { once: true });
      waiters.add(wake);
    });
  }

  #takeInbox(seq: number): InboxRow | null {
    const row = this.#sql<InboxRow>(
      "SELECT * FROM cf_agents_harness_inbox WHERE seq = ?",
      seq
    )[0];
    if (!row) return null;
    this.lifecycle.storage.sql.exec(
      "DELETE FROM cf_agents_harness_inbox WHERE seq = ?",
      seq
    );
    return row;
  }

  #requestRows(sessionId: string, operationId?: string): RequestRow[] {
    return operationId === undefined
      ? this.#sql<RequestRow>(
          "SELECT * FROM cf_agents_harness_requests WHERE session_id = ? ORDER BY asked_at ASC",
          sessionId
        )
      : this.#sql<RequestRow>(
          "SELECT * FROM cf_agents_harness_requests WHERE session_id = ? AND operation_id = ? ORDER BY asked_at ASC",
          sessionId,
          operationId
        );
  }

  #requestRow(requestId: string): RequestRow | undefined {
    return this.#sql<RequestRow>(
      "SELECT * FROM cf_agents_harness_requests WHERE request_id = ?",
      requestId
    )[0];
  }

  // ── Projections ──────────────────────────────────────────────────────────

  #toInboxRow(row: InboxRow): HarnessInboxRow<P> {
    return {
      seq: row.seq,
      key: row.key,
      operationId: row.operation_id,
      // SAFETY: rows are written by this capability from validated kinds.
      kind: row.kind as HarnessInboxRow<P>["kind"],
      payload: JSON.parse(row.payload) as JsonValue,
      createdAt: row.created_at
    };
  }

  #toRequest(row: RequestRow): HarnessRequest {
    // SAFETY: the payload was written from a HarnessRequestDraft of `type`.
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    return {
      ...payload,
      type: row.type,
      requestId: row.request_id,
      sessionId: row.session_id,
      operationId: row.operation_id,
      createdAt: row.asked_at,
      expiresAt: row.expires_at
    } as HarnessRequest;
  }

  #toResult(row: OperationRow): HarnessResult<P> | undefined {
    if (row.status !== "settled" || row.result === null) return undefined;
    return JSON.parse(row.result) as HarnessResult<P>;
  }

  #receipt(row: OperationRow, accepted: boolean): HarnessReceipt {
    return {
      operationId: row.operation_id,
      sessionId: row.session_id,
      streamId: harnessOperationStreamId(row.session_id, row.operation_id),
      cursor: this.#cursor(row.session_id),
      accepted,
      state: row.status,
      delivery: row.delivery
    };
  }

  /** The head of the session's log as an opaque cursor. */
  #cursor(sessionId: string): string {
    return String(this.#seq.get(sessionId) ?? -1);
  }

  #runState(sessionId: string, row: SessionRow | undefined): HarnessRunState {
    if (!row) return "idle";
    if (this.#requestRows(sessionId).length > 0) return "blocked";
    if (this.#runningOperation(sessionId)) {
      return this.#runStates.get(sessionId) ?? "running";
    }
    return "idle";
  }

  #ensureSingleSession(sessionId: string): void {
    if (
      !this.#runtime.capabilities.has("sessions") &&
      sessionId !== DEFAULT_SESSION_ID
    ) {
      throw new HarnessSessionNotFoundError(sessionId);
    }
  }

  // ── Session seq ──────────────────────────────────────────────────────────

  nextSeq(sessionId: string): number {
    const next = (this.#seq.get(sessionId) ?? -1) + 1;
    this.#seq.set(sessionId, next);
    return next;
  }

  /** Seed the seq counter from the newest durable frame. Two or three reads, once per isolate. */
  async #seedSeq(sessionId: string): Promise<number> {
    const known = this.#seq.get(sessionId);
    if (known !== undefined) return known;
    let seeding = this.#seeding.get(sessionId);
    if (!seeding) {
      seeding = (async () => {
        const [newest] = await this.#streams.list({
          tag: harnessSessionTag(sessionId),
          limit: 1
        });
        const sessionLog = await this.#streams.status(
          harnessSessionStreamId(sessionId)
        );
        let max = -1;
        for (const status of [newest, sessionLog]) {
          if (!status || status.cursor === 0) continue;
          for await (const chunk of this.#streams.read(status.streamId, {
            from: status.cursor - 1
          })) {
            const frames = chunk.chunk as unknown as readonly HarnessFrame[];
            const last = frames.at(-1);
            if (last) max = Math.max(max, last.seq);
            break;
          }
        }
        if (!this.#seq.has(sessionId)) this.#seq.set(sessionId, max);
        return this.#seq.get(sessionId) ?? max;
      })().finally(() => this.#seeding.delete(sessionId));
      this.#seeding.set(sessionId, seeding);
    }
    return seeding;
  }

  // ── Logs ─────────────────────────────────────────────────────────────────

  async #sessionLog(sessionId: string): Promise<LogWriter<P>> {
    const existing = this.#sessionLogs.get(sessionId);
    if (existing) return existing;
    await this.#seedSeq(sessionId);
    const streamId = harnessSessionStreamId(sessionId);
    let writer: StreamWriter | undefined;
    try {
      writer = await this.#streams.open(streamId, {
        tag: harnessSessionTag(sessionId),
        metadata: { sessionId }
      });
    } catch {
      writer = undefined;
    }
    const log = new LogWriter<P>(this, sessionId, undefined, streamId, writer);
    this.#sessionLogs.set(sessionId, log);
    return log;
  }

  async #operationLog(row: OperationRow): Promise<LogWriter<P>> {
    const existing = this.#operationLogs.get(row.operation_id);
    if (existing) return existing;
    await this.#seedSeq(row.session_id);
    const streamId = harnessOperationStreamId(row.session_id, row.operation_id);
    let writer: StreamWriter | undefined;
    try {
      writer = await this.#streams.open(streamId, {
        tag: harnessSessionTag(row.session_id),
        metadata: { sessionId: row.session_id, operationId: row.operation_id }
      });
    } catch {
      // Already settled by a previous attempt: events have nowhere to go.
      writer = undefined;
    }
    const log = new LogWriter<P>(
      this,
      row.session_id,
      row.operation_id,
      streamId,
      writer
    );
    this.#operationLogs.set(row.operation_id, log);
    return log;
  }

  transaction(work: () => void): void {
    this.lifecycle.storage.transactionSync(work);
  }

  flushOlder(sessionId: string, beforeSeq: number): void {
    for (const log of this.#operationLogs.values()) {
      const first = log.pendingFirstSeq;
      if (
        log.sessionId === sessionId &&
        first !== undefined &&
        first < beforeSeq
      ) {
        log.flush();
      }
    }
    const session = this.#sessionLogs.get(sessionId);
    const first = session?.pendingFirstSeq;
    if (session && first !== undefined && first < beforeSeq) session.flush();
  }

  deliverFrames(
    sessionId: string,
    streamId: string,
    frames: readonly HarnessFrame<P>[]
  ): void {
    const subscribers = this.#subscribers.get(sessionId);
    if (!subscribers) return;
    for (const subscriber of subscribers) {
      try {
        subscriber.frames(streamId, frames);
      } catch (error) {
        console.error("Harness subscriber failed", error);
      }
    }
  }

  deliverPreview(preview: HarnessPreview): void {
    const subscribers = this.#subscribers.get(preview.sessionId);
    if (!subscribers) return;
    for (const subscriber of subscribers) {
      if (!subscriber.previews) continue;
      try {
        subscriber.preview(preview);
      } catch (error) {
        console.error("Harness subscriber failed", error);
      }
    }
  }

  /** True while at least one browser socket is attached to the session. */
  attached(sessionId: string): boolean {
    const services = this.lifecycleServices;
    if (!services) return false;
    return services.sockets.get(harnessSessionTag(sessionId)).length > 0;
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  async #createSession(
    options: HarnessSessionCreateOptions = {}
  ): Promise<HarnessSession<P>> {
    await this.lifecycle.ready();
    const sessionId = validateSessionId(
      options.sessionId ?? DEFAULT_SESSION_ID
    );
    if (
      !this.#runtime.capabilities.has("sessions") &&
      sessionId !== DEFAULT_SESSION_ID
    ) {
      throw new HarnessCapabilityUnsupportedError("sessions");
    }
    await this.#ensureSession(sessionId, options);
    return this.session(sessionId);
  }

  /** Create the session row and open its log once. Idempotent. */
  async #ensureSession(
    sessionId: string,
    options: HarnessSessionCreateOptions = {}
  ): Promise<SessionRow> {
    const existing = this.#sessionRow(sessionId);
    if (existing) return existing;
    const log = await this.#sessionLog(sessionId);
    const now = Date.now();
    this.lifecycle.storage.sql.exec(
      `INSERT OR IGNORE INTO cf_agents_harness_sessions
         (session_id, title, parent_id, config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      sessionId,
      options.title ?? null,
      options.parentSessionId ?? null,
      options.config === undefined ? null : JSON.stringify(options.config),
      now,
      now
    );
    const row = this.#sessionRow(sessionId);
    if (!row) throw new HarnessSessionNotFoundError(sessionId);
    await this.#runtime.create?.(sessionId, { ...options, sessionId });
    log.append({
      type: "session_opened",
      status: await this.#status(sessionId)
    });
    log.flush();
    return row;
  }

  async #listSessions(
    options: HarnessSessionListOptions = {}
  ): Promise<HarnessSessionPage> {
    await this.lifecycle.ready();
    const limit = Math.max(
      1,
      Math.min(options.limit ?? SESSION_LIST_LIMIT, 1000)
    );
    const order = options.order === "desc" ? "DESC" : "ASC";
    const after = options.cursor === undefined ? null : Number(options.cursor);
    const rows = this.#sql<SessionRow>(
      `SELECT * FROM cf_agents_harness_sessions
       WHERE (? IS NULL OR (created_at ${order === "ASC" ? ">" : "<"} ?))
       ORDER BY created_at ${order}, session_id ${order} LIMIT ?`,
      after,
      after,
      limit + 1
    );
    const page = rows.slice(0, limit);
    const sessions: HarnessSessionInfo[] = page.map((row) => ({
      sessionId: row.session_id,
      ...(row.parent_id === null ? {} : { parentSessionId: row.parent_id }),
      ...(row.title === null ? {} : { title: row.title }),
      state: this.#runState(row.session_id, row),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
    const last = page.at(-1);
    return {
      sessions,
      ...(rows.length > limit && last
        ? { cursor: String(last.created_at) }
        : {})
    };
  }

  async #deleteSession(sessionId: string): Promise<void> {
    await this.lifecycle.ready();
    validateSessionId(sessionId);
    await this.#tasks.cancel(this.#runId(sessionId), "session deleted");
    for (const row of this.#sql<{ operation_id: string }>(
      "SELECT operation_id FROM cf_agents_harness_operations WHERE session_id = ?",
      sessionId
    )) {
      this.#interrupts.get(row.operation_id)?.abort("session deleted");
      this.#interrupts.delete(row.operation_id);
    }
    const requests = this.#requestRows(sessionId);
    for (const request of requests) {
      await this.lifecycle.jobs.cancel(`rt:${request.request_id}`);
      this.#askWaiters
        .get(request.request_id)
        ?.reject(new HarnessClosedError("Session deleted"));
      this.#askWaiters.delete(request.request_id);
    }
    const streams = await this.#streams.list({
      tag: harnessSessionTag(sessionId),
      limit: 1000
    });
    for (const status of streams) {
      if (status.state === "streaming") {
        const writer = await this.#streams.open(status.streamId);
        writer.error("session deleted");
      }
      await this.#streams.delete(status.streamId);
    }
    this.lifecycle.storage.transactionSync(() => {
      const sql = this.lifecycle.storage.sql;
      sql.exec(
        "DELETE FROM cf_agents_harness_requests WHERE session_id = ?",
        sessionId
      );
      sql.exec(
        "DELETE FROM cf_agents_harness_inbox WHERE session_id = ?",
        sessionId
      );
      sql.exec(
        "DELETE FROM cf_agents_harness_operations WHERE session_id = ?",
        sessionId
      );
      sql.exec(
        "DELETE FROM cf_agents_harness_sessions WHERE session_id = ?",
        sessionId
      );
    });
    for (const [operationId, log] of this.#operationLogs) {
      if (log.sessionId === sessionId) this.#operationLogs.delete(operationId);
    }
    this.#sessionLogs.delete(sessionId);
    this.#seq.delete(sessionId);
    this.#runStates.delete(sessionId);
    await this.#runtime.delete?.(sessionId);
    this.#transport?.sessionDeleted(sessionId);
  }

  // ── Admission ────────────────────────────────────────────────────────────

  /** `prompt()`, `submit()` and `compact()` are this one write. */
  async admit(
    sessionId: string,
    kind: string,
    payload: unknown,
    options: {
      readonly operationId?: string;
      readonly delivery?: "queue" | "steer";
    } = {}
  ): Promise<HarnessReceipt> {
    await this.lifecycle.ready();
    this.#ensureSingleSession(sessionId);
    const delivery = options.delivery ?? "queue";
    if (delivery === "steer" && !this.#runtime.capabilities.has("steer")) {
      throw new HarnessCapabilityUnsupportedError("steer");
    }
    if (kind === "compact" && !this.#runtime.capabilities.has("compact")) {
      throw new HarnessCapabilityUnsupportedError("compact");
    }
    await this.#ensureSession(sessionId);
    const operationId = options.operationId ?? crypto.randomUUID();
    const hash = await sha256(canonical({ kind, payload, delivery }));
    // Nothing throws inside the transaction: workerd reports a throwing
    // callback as an uncaught rejection besides rolling back.
    const outcome = this.lifecycle.storage.transactionSync(
      ():
        | { readonly receipt: HarnessReceipt }
        | { readonly conflict: true }
        | { readonly backpressure: true } => {
        const known = this.#operationRow(operationId);
        if (known) {
          if (known.input_hash !== hash) return { conflict: true };
          return { receipt: this.#receipt(known, false) };
        }
        if (this.#inboxCount(sessionId) >= this.#policy.inboxLimit) {
          return { backpressure: true };
        }
        const now = Date.now();
        this.lifecycle.storage.sql.exec(
          `INSERT INTO cf_agents_harness_operations
           (operation_id, session_id, status, kind, delivery, input_hash, payload, created_at)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)`,
          operationId,
          sessionId,
          kind,
          delivery,
          hash,
          JSON.stringify(payload ?? null),
          now
        );
        this.#insertInbox({
          sessionId,
          key: operationId,
          operationId,
          kind,
          payload
        });
        const row = this.#operationRow(operationId);
        return row ? { receipt: this.#receipt(row, true) } : { conflict: true };
      }
    );
    if ("conflict" in outcome) throw new HarnessConflictError(operationId);
    if ("backpressure" in outcome) {
      throw new HarnessBackpressureError(
        `Session ${sessionId} has ${this.#policy.inboxLimit} unconsumed inputs`
      );
    }
    const receipt = outcome.receipt;
    if (receipt.accepted) await this.#ensureDriver(sessionId);
    return receipt;
  }

  async interrupt(
    sessionId: string,
    options: HarnessInterruptOptions = {}
  ): Promise<HarnessInterruptResult> {
    await this.lifecycle.ready();
    this.#ensureSingleSession(sessionId);
    const drained: { operationId: string; input: HarnessInput }[] = [];
    if (options.drain ?? true) {
      for (const queued of this.#queuedOperations(sessionId)) {
        const rows = this.#inboxRows(sessionId).filter(
          (row) => row.operation_id === queued.operation_id
        );
        let input: HarnessInput = "";
        for (const row of rows) {
          const payload = JSON.parse(row.payload) as unknown;
          if (row.kind === "prompt" && isRecord(payload)) {
            input = payload.input as HarnessInput;
          }
          this.#takeInbox(row.seq);
        }
        await this.#decline(queued, options.reason ?? "interrupted");
        drained.push({ operationId: queued.operation_id, input });
      }
    }
    const active =
      options.operationId === undefined
        ? this.#runningOperation(sessionId)
        : this.#operationRow(options.operationId);
    if (!active || active.status !== "running") {
      return { operationId: null, newlyRequested: false, drained };
    }
    const key = `interrupt:${active.operation_id}`;
    const newlyRequested = !this.#inboxHasKey(sessionId, key);
    if (newlyRequested) {
      this.#insertInbox({
        sessionId,
        key,
        operationId: active.operation_id,
        kind: "interrupt",
        payload: {
          operationId: active.operation_id,
          ...(options.reason === undefined ? {} : { reason: options.reason })
        }
      });
    }
    this.#interruptSignal(active.operation_id).abort(
      options.reason ?? "interrupted"
    );
    await this.#ensureDriver(sessionId);
    return { operationId: active.operation_id, newlyRequested, drained };
  }

  #interruptSignal(operationId: string): AbortController {
    let controller = this.#interrupts.get(operationId);
    if (!controller) {
      controller = new AbortController();
      this.#interrupts.set(operationId, controller);
    }
    return controller;
  }

  async requests(sessionId: string): Promise<readonly HarnessRequest[]> {
    await this.lifecycle.ready();
    this.#ensureSingleSession(sessionId);
    return this.#requestRows(sessionId).map((row) => this.#toRequest(row));
  }

  async reply(
    sessionId: string,
    requestId: string,
    reply: HarnessReply
  ): Promise<{ readonly accepted: boolean }> {
    await this.lifecycle.ready();
    this.#ensureSingleSession(sessionId);
    return this.#reply(sessionId, requestId, reply, "client");
  }

  async #reply(
    sessionId: string,
    requestId: string,
    reply: HarnessReply,
    by: "client" | "timeout"
  ): Promise<{ readonly accepted: boolean }> {
    const request = this.#requestRow(requestId);
    if (!request || request.session_id !== sessionId) {
      return { accepted: false };
    }
    if (request.type !== reply.type) return { accepted: false };
    const waiter = this.#askWaiters.get(requestId);
    if (waiter) {
      // The asking runtime is live in this isolate: close and resolve now.
      await this.#closeRequest(
        request,
        by === "client" ? "answered" : by,
        reply
      );
      waiter.resolve(reply);
      return { accepted: true };
    }
    if (this.#inboxHasKey(sessionId, requestId)) return { accepted: false };
    this.#insertInbox({
      sessionId,
      key: requestId,
      operationId: request.operation_id,
      kind: "reply",
      payload: { requestId, reply, by }
    });
    await this.#ensureDriver(sessionId);
    return { accepted: true };
  }

  async #timeoutRequest(requestId: string): Promise<void> {
    const request = this.#requestRow(requestId);
    if (!request) return;
    const timeout = timeoutReply(request.type);
    if (!timeout) return;
    await this.#reply(request.session_id, requestId, timeout, "timeout");
  }

  /** Delete the request row and record the answer. */
  async #closeRequest(
    request: RequestRow,
    by: "answered" | "timeout" | "lost",
    reply?: HarnessReply
  ): Promise<void> {
    this.lifecycle.storage.sql.exec(
      "DELETE FROM cf_agents_harness_requests WHERE request_id = ?",
      request.request_id
    );
    await this.lifecycle.jobs.cancel(`rt:${request.request_id}`);
    const recorded = reply ?? timeoutReply(request.type);
    if (recorded) {
      const log =
        this.#operationLogs.get(request.operation_id) ??
        (await this.#sessionLog(request.session_id));
      log.append({
        type: "request_replied",
        requestId: request.request_id,
        reply: recorded,
        by: by === "answered" ? "client" : by
      });
      log.flush();
    }
    this.#transport?.requestsChanged(request.session_id);
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async status(sessionId: string): Promise<HarnessStatus> {
    await this.lifecycle.ready();
    this.#ensureSingleSession(sessionId);
    return this.#status(sessionId);
  }

  async #status(sessionId: string): Promise<HarnessStatus> {
    await this.#seedSeq(sessionId);
    const row = this.#sessionRow(sessionId);
    const requests = this.#requestRows(sessionId);
    const running = this.#runningOperation(sessionId);
    const state: HarnessRunState = !row
      ? "idle"
      : requests.length > 0
        ? "blocked"
        : running
          ? (this.#runStates.get(sessionId) ?? "running")
          : "idle";
    const lastSettled = running
      ? undefined
      : this.#sql<OperationRow>(
          `SELECT * FROM cf_agents_harness_operations
           WHERE session_id = ? AND status = 'settled'
           ORDER BY settled_at DESC LIMIT 1`,
          sessionId
        )[0];
    const lastResult = lastSettled ? this.#toResult(lastSettled) : undefined;
    const queued =
      this.#sql<{ n: number }>(
        "SELECT count(*) AS n FROM cf_agents_harness_operations WHERE session_id = ? AND status = 'queued'",
        sessionId
      )[0]?.n ?? 0;
    const usage = await this.#runtime.usage?.(sessionId);
    const config =
      row?.config === null || row?.config === undefined
        ? undefined
        : (JSON.parse(row.config) as HarnessConfig);
    return {
      sessionId,
      state,
      ...(running ? { operationId: running.operation_id } : {}),
      ...(lastResult ? { stopReason: lastResult.stopReason } : {}),
      pendingRequests: requests.map((request) => request.request_id),
      queuedOperations: queued,
      cursor: this.#cursor(sessionId),
      capabilities: [...this.#runtime.capabilities],
      ...(usage === undefined ? {} : { usage }),
      ...(config === undefined ? {} : { config })
    };
  }

  async result(
    sessionId: string,
    operationId: string
  ): Promise<HarnessResult<P> | undefined> {
    await this.lifecycle.ready();
    const row = this.#operationRow(operationId);
    if (!row || row.session_id !== sessionId) return undefined;
    return this.#toResult(row);
  }

  async wait(
    sessionId: string,
    operationId: string,
    options: HarnessWaitOptions = {}
  ): Promise<HarnessResult<P>> {
    await this.lifecycle.ready();
    const deadline =
      options.timeoutMs === undefined
        ? undefined
        : Date.now() + options.timeoutMs;
    for (;;) {
      const row = this.#operationRow(operationId);
      if (!row || row.session_id !== sessionId) {
        throw new HarnessOperationNotFoundError(operationId);
      }
      const result = this.#toResult(row);
      if (result) return result;
      if (options.signal?.aborted) {
        throw new HarnessTimeoutError("wait() aborted");
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new HarnessTimeoutError(
          `Operation ${operationId} did not settle within ${options.timeoutMs} ms`
        );
      }
      await this.#awaitSettlement(operationId, options.signal);
    }
  }

  #awaitSettlement(operationId: string, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let waiters = this.#settlementWaiters.get(operationId);
      if (!waiters) {
        waiters = new Set();
        this.#settlementWaiters.set(operationId, waiters);
      }
      const wake = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", wake);
        waiters?.delete(wake);
        resolve();
      };
      // The poll is insurance: settlement normally wakes waiters directly.
      const timer = setTimeout(wake, RESULT_POLL_MS);
      signal?.addEventListener("abort", wake, { once: true });
      waiters.add(wake);
    });
  }

  #notifySettled(operationId: string): void {
    const waiters = this.#settlementWaiters.get(operationId);
    this.#settlementWaiters.delete(operationId);
    if (waiters) for (const wake of waiters) wake();
  }

  async messages(
    sessionId: string,
    options: HarnessMessagesOptions = {}
  ): Promise<HarnessMessagePage> {
    await this.lifecycle.ready();
    this.#ensureSingleSession(sessionId);
    await this.#seedSeq(sessionId);
    const asOf = this.#cursor(sessionId);
    const page = await this.#runtime.messages(sessionId, {
      maxBytes: options.maxBytes ?? DEFAULT_MESSAGE_BYTES,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor })
    });
    return {
      messages: page.messages,
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      asOf
    };
  }

  // ── Events ───────────────────────────────────────────────────────────────

  async *events(
    sessionId: string,
    options: HarnessEventsOptions = {}
  ): AsyncGenerator<HarnessEvent<P> | HarnessPreview, void, undefined> {
    await this.lifecycle.ready();
    this.#ensureSingleSession(sessionId);
    await this.#seedSeq(sessionId);
    const signal = options.signal;
    const fromSeq = parseCursor(options.from);
    let lastSeq = fromSeq;

    // Subscribe before replaying so nothing flushed meanwhile is missed;
    // anything the replay also returns is deduped by seq.
    const queue: (HarnessEvent<P> | HarnessPreview)[] = [];
    let overflowed = false;
    let wake: (() => void) | undefined;
    const notify = () => {
      const pending = wake;
      wake = undefined;
      pending?.();
    };
    const subscriber: LiveSubscriber = {
      previews: options.previews ?? false,
      frames: (streamId, frames) => {
        for (const frame of frames) {
          queue.push(
            this.#toEvent(sessionId, streamId, frame as HarnessFrame<P>)
          );
        }
        if (queue.length > MAX_LIVE_QUEUE) {
          // A stalled consumer must not grow the isolate: drop the buffer
          // and catch up from the durable log instead.
          queue.length = 0;
          overflowed = true;
        }
        notify();
      },
      preview: (preview) => {
        queue.push(preview);
        notify();
      }
    };
    let subscribers = this.#subscribers.get(sessionId);
    if (!subscribers) {
      subscribers = new Set();
      this.#subscribers.set(sessionId, subscribers);
    }
    subscribers.add(subscriber);
    const onAbort = () => notify();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      for (const event of await this.#replay(sessionId, fromSeq)) {
        if (signal?.aborted) return;
        lastSeq = event.seq;
        yield { ...event, replay: true };
      }
      options.onUpToDate?.();
      for (;;) {
        if (signal?.aborted) return;
        if (overflowed && queue.length === 0) {
          overflowed = false;
          for (const event of await this.#replay(sessionId, lastSeq)) {
            if (signal?.aborted) return;
            lastSeq = event.seq;
            yield { ...event, replay: true };
          }
          continue;
        }
        const item = queue.shift();
        if (item === undefined) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        if ("preview" in item) {
          yield item;
          continue;
        }
        if (item.seq <= lastSeq) continue;
        lastSeq = item.seq;
        yield item;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      subscribers.delete(subscriber);
      if (subscribers.size === 0) this.#subscribers.delete(sessionId);
    }
  }

  #toEvent(
    sessionId: string,
    streamId: string,
    frame: HarnessFrame<P>
  ): HarnessEvent<P> {
    return {
      seq: frame.seq,
      streamId,
      cursor: String(frame.seq),
      sessionId,
      ...(frame.operationId === undefined
        ? {}
        : { operationId: frame.operationId }),
      ...(frame.wire === undefined ? {} : { wire: frame.wire }),
      body: frame.body
    };
  }

  /** Every durable frame of the session with seq greater than `fromSeq`, in seq order. */
  async #replay(
    sessionId: string,
    fromSeq: number
  ): Promise<HarnessEvent<P>[]> {
    // An operation whose last frame sits at or below the cursor has nothing
    // to replay; its log is skipped without a read. Running operations and
    // the session log are read in full and filtered.
    const candidates = [harnessSessionStreamId(sessionId)];
    for (const row of this.#sql<{
      operation_id: string;
      status: string;
      last_seq: number | null;
    }>(
      `SELECT operation_id, status, last_seq FROM cf_agents_harness_operations
       WHERE session_id = ? AND status != 'queued' ORDER BY created_at ASC`,
      sessionId
    )) {
      if (row.last_seq !== null && row.last_seq <= fromSeq) continue;
      candidates.push(harnessOperationStreamId(sessionId, row.operation_id));
    }
    const events: HarnessEvent<P>[] = [];
    for (const streamId of candidates) {
      const status = await this.#streams.status(streamId);
      if (!status || status.cursor === 0) continue;
      let seen = 0;
      for await (const chunk of this.#streams.read(status.streamId)) {
        seen += 1;
        const frames = chunk.chunk as unknown as readonly HarnessFrame<P>[];
        for (const frame of frames) {
          if (frame.seq > fromSeq) {
            events.push(this.#toEvent(sessionId, status.streamId, frame));
          }
        }
        // `read()` tails a live stream forever; stop at the durable head.
        if (seen >= status.cursor) break;
      }
    }
    events.sort((left, right) => left.seq - right.seq);
    return events;
  }

  // ── Extensions ───────────────────────────────────────────────────────────

  async fork(
    sessionId: string,
    options: HarnessForkOptions
  ): Promise<HarnessSession<P>> {
    await this.lifecycle.ready();
    const fork = this.#runtime.fork;
    if (!fork || !this.#runtime.capabilities.has("fork")) {
      throw new HarnessCapabilityUnsupportedError("fork");
    }
    const forkId = await fork.call(this.#runtime, sessionId, options);
    await this.#ensureSession(forkId, {
      sessionId: forkId,
      parentSessionId: sessionId
    });
    return this.session(forkId);
  }

  async rewind(
    sessionId: string,
    toMessageId: string,
    options: HarnessRewindOptions
  ): Promise<HarnessRewindResult> {
    await this.lifecycle.ready();
    const rewind = this.#runtime.rewind;
    if (!rewind || !this.#runtime.capabilities.has("rewind")) {
      throw new HarnessCapabilityUnsupportedError("rewind");
    }
    return rewind.call(this.#runtime, sessionId, toMessageId, options);
  }

  async configure(
    sessionId: string,
    patch: HarnessConfigPatch
  ): Promise<HarnessConfig> {
    await this.lifecycle.ready();
    const configure = this.#runtime.configure;
    if (!configure || !this.#runtime.capabilities.has("configure")) {
      throw new HarnessCapabilityUnsupportedError("configure");
    }
    await this.#ensureSession(sessionId);
    const config = await configure.call(this.#runtime, sessionId, patch);
    this.lifecycle.storage.sql.exec(
      "UPDATE cf_agents_harness_sessions SET config = ?, updated_at = ? WHERE session_id = ?",
      JSON.stringify(config),
      Date.now(),
      sessionId
    );
    return config;
  }

  async cancelQueued(sessionId: string, operationId: string): Promise<boolean> {
    await this.lifecycle.ready();
    const cancel = this.#runtime.cancelQueued;
    if (!cancel || !this.#runtime.capabilities.has("queue")) {
      throw new HarnessCapabilityUnsupportedError("queue");
    }
    return cancel.call(this.#runtime, sessionId, operationId);
  }

  async close(sessionId: string): Promise<void> {
    await this.lifecycle.ready();
    for (const log of this.#operationLogs.values()) {
      if (log.sessionId === sessionId) log.flush();
    }
    this.#sessionLogs.get(sessionId)?.flush();
    await this.#runtime.close?.(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    return this.#deleteSession(sessionId);
  }

  // ── Driver ───────────────────────────────────────────────────────────────

  #runId(sessionId: string): string {
    return `harness:${this.capabilityId}:${sessionId}`;
  }

  async #ensureDriver(sessionId: string): Promise<void> {
    let ensuring = this.#ensuring.get(sessionId);
    if (!ensuring) {
      ensuring = this.#startDriver(sessionId).finally(() => {
        this.#ensuring.delete(sessionId);
      });
      this.#ensuring.set(sessionId, ensuring);
    }
    return ensuring;
  }

  async #startDriver(sessionId: string): Promise<void> {
    const receipt = await this.#tasks.__DO_NOT_USE_WILL_BREAK__enqueue(
      this.#definition,
      { version: 1, sessionId } satisfies DriverInput,
      { runId: this.#runId(sessionId), retain: false }
    );
    if (!receipt.accepted && this.#inboxCount(sessionId) > 0) {
      // Joined a live run that may be settling right now: a short re-ensure
      // closes the window between its last inbox read and its exit.
      await this.#wake(sessionId, 250);
    }
  }

  /** Push the one Lifecycle job that re-enters the driver for a session. */
  async #wake(sessionId: string, afterMs: number): Promise<void> {
    const id = `${DRIVE_FN}:${sessionId}`;
    let time = Date.now() + Math.max(0, afterMs);
    // A push with an existing id replaces the job: keep the earlier wake.
    const pending = this.lifecycle.jobs.get(id);
    if (pending && pending.time < time) time = pending.time;
    await this.lifecycle.jobs.push({
      id,
      fn: DRIVE_FN,
      time,
      payload: { sessionId }
    });
  }

  async #drive(
    input: DriverInput,
    step: TaskStep
  ): Promise<{ sessionId: string; passes: number; rotated?: true }> {
    const { sessionId } = input;
    const controller = new AbortController();
    this.#driveControllers.add(controller);
    let failures = 0;
    let stuck = 0;
    let lastHead: number | undefined;
    try {
      for (let pass = 0; pass < this.#policy.rotateAfterPasses; pass++) {
        if (this.#disposed || controller.signal.aborted) {
          return { sessionId, passes: pass };
        }
        if (!this.#sessionRow(sessionId)) return { sessionId, passes: pass };
        this.#runStates.delete(sessionId);
        this.#pendingWakes.delete(sessionId);
        // The session log is the fallback for frames raised outside an
        // operation handle (a request opened for a closed operation), so it
        // is open before the runtime runs.
        await this.#sessionLog(sessionId);
        const ctx = this.#driveContext(sessionId, step, controller.signal);
        let threw = false;
        try {
          await this.#runtime.drive(ctx);
        } catch (error) {
          // Tasks steers a run by throwing control values (a parked step,
          // a durable sleep, a cancellation, a superseded attempt) and the
          // platform by throwing its own failures; those belong to Tasks.
          if (isTaskControl(error)) {
            this.#flushSession(sessionId);
            throw error;
          }
          threw = true;
          await this.#driveFailed(sessionId, error);
        }
        this.#flushSession(sessionId);
        if (controller.signal.aborted) return { sessionId, passes: pass + 1 };

        const wakeAfter = this.#pendingWakes.get(sessionId);
        const head = this.#inboxRows(sessionId, undefined, 1)[0];
        if (!head) {
          // Idle. The runtime may still be working elsewhere (a remote
          // engine); it asked for a wake if so.
          if (wakeAfter !== undefined) await this.#wake(sessionId, wakeAfter);
          return { sessionId, passes: pass + 1 };
        }
        const progressed = head.seq !== lastHead;
        lastHead = head.seq;
        if (threw) {
          failures = progressed ? 1 : failures + 1;
        } else if (progressed) {
          // More work is queued and the runtime is making progress: go
          // again now, whatever wake it asked for.
          failures = 0;
          stuck = 0;
          continue;
        } else if (wakeAfter === undefined) {
          // The runtime returned without consuming the head and without
          // asking for a wake: do not spin.
          stuck += 1;
        }
        if (
          failures >= this.#policy.maxPassFailures ||
          stuck >= this.#policy.maxPassFailures
        ) {
          await this.#poison(sessionId, head, threw ? "failed" : "unconsumed");
          failures = 0;
          stuck = 0;
          continue;
        }
        if (!threw && wakeAfter !== undefined) {
          await this.#wake(sessionId, wakeAfter);
          return { sessionId, passes: pass + 1 };
        }
        await this.#wake(sessionId, errorBackoffMs(failures + stuck));
        return { sessionId, passes: pass + 1 };
      }
      // Rotate: this run completes, and a fresh driver picks the session up.
      await this.#wake(sessionId, ROTATION_DELAY_MS);
      return {
        sessionId,
        passes: this.#policy.rotateAfterPasses,
        rotated: true
      };
    } finally {
      this.#driveControllers.delete(controller);
    }
  }

  #flushSession(sessionId: string): void {
    for (const log of this.#operationLogs.values()) {
      if (log.sessionId === sessionId) log.flush();
    }
    this.#sessionLogs.get(sessionId)?.flush();
  }

  /** A runtime threw out of `drive()`: settle what it was running as failed. */
  async #driveFailed(sessionId: string, error: unknown): Promise<void> {
    const summary = errorSummary(error);
    console.error(`Harness runtime ${this.#runtime.id} failed`, error);
    this.lifecycle.events.emit("harness:drive_failed", {
      sessionId,
      ...summary
    });
    const running = this.#runningOperation(sessionId);
    if (!running) return;
    await this.#settle(running.operation_id, {
      status: "failed",
      stopReason: { type: "error", raw: summary.code },
      error: summary
    });
  }

  /** Drop an inbox row the runtime cannot consume, settling its operation. */
  async #poison(
    sessionId: string,
    head: InboxRow,
    reason: "failed" | "unconsumed"
  ): Promise<void> {
    this.#takeInbox(head.seq);
    if (head.operation_id === null) return;
    const row = this.#operationRow(head.operation_id);
    if (!row || row.status === "settled") return;
    const message =
      reason === "failed"
        ? `Runtime ${this.#runtime.id} failed ${this.#policy.maxPassFailures} times on this input`
        : `Runtime ${this.#runtime.id} did not consume this input`;
    this.lifecycle.events.emit("harness:poisoned", {
      sessionId,
      operationId: head.operation_id,
      kind: head.kind,
      reason
    });
    if (row.status === "queued") await this.#decline(row, message);
    else {
      await this.#settle(row.operation_id, {
        status: "failed",
        stopReason: { type: "error", raw: reason },
        error: { code: "E_POISON", message }
      });
    }
  }

  #driveContext(
    sessionId: string,
    step: TaskStep,
    signal: AbortSignal
  ): HarnessDriveContext<P> {
    return {
      sessionId,
      step,
      signal,
      inbox: {
        peek: (options) =>
          this.#inboxRows(sessionId, options?.kinds, options?.limit).map(
            (row) => this.#toInboxRow(row)
          ),
        take: (seq) => {
          const row = this.#takeInbox(seq);
          return row && row.session_id === sessionId
            ? this.#toInboxRow(row)
            : null;
        },
        wait: (waitSignal) => this.#awaitInbox(sessionId, waitSignal)
      },
      begin: (operationId, options) =>
        this.#begin(sessionId, operationId, options?.delivery),
      adopt: (operationId, options) =>
        this.#adopt(sessionId, operationId, options),
      settle: (operationId, outcome) => this.#settle(operationId, outcome),
      operation: (operationId) => this.#operationLogs.get(operationId),
      active: () => {
        const running = this.#runningOperation(sessionId);
        return running ? this.#toActive(running) : null;
      },
      interrupted: (operationId) => {
        const controller = this.#interruptSignal(operationId);
        if (
          !controller.signal.aborted &&
          this.#inboxHasKey(sessionId, `interrupt:${operationId}`)
        ) {
          controller.abort("interrupted");
        }
        return controller.signal;
      },
      requests: {
        open: (draft) => this.#openRequest(sessionId, draft),
        close: async (requestId, by, reply) => {
          const request = this.#requestRow(requestId);
          if (!request) return;
          await this.#closeRequest(request, by, reply);
        },
        list: (operationId) =>
          this.#requestRows(sessionId, operationId).map((row) =>
            this.#toRequest(row)
          )
      },
      ask: (draft) => this.#ask(sessionId, draft),
      wake: (afterMs) => {
        const current = this.#pendingWakes.get(sessionId);
        const next = Math.max(0, afterMs ?? 0);
        this.#pendingWakes.set(
          sessionId,
          current === undefined ? next : Math.min(current, next)
        );
      },
      session: () => this.#sessionLog(sessionId),
      attached: () => this.attached(sessionId),
      setRunState: (state) => {
        this.#runStates.set(sessionId, state);
      }
    };
  }

  // ── Operations ───────────────────────────────────────────────────────────

  #toActive(row: OperationRow): HarnessActiveOperation<P> {
    return {
      operationId: row.operation_id,
      // SAFETY: kinds are written by admit() from validated kinds, or "adopted".
      kind: row.kind as HarnessActiveOperation<P>["kind"],
      payload:
        row.payload === null ? null : (JSON.parse(row.payload) as JsonValue),
      delivery: row.delivery,
      startedAt: row.started_at ?? row.created_at
    };
  }

  /** Insert the row for an engine-originated operation, then begin it. */
  async #adopt(
    sessionId: string,
    operationId: string,
    options: { readonly kind: string; readonly delivery?: "queue" | "steer" }
  ): Promise<HarnessOperationHandle<P>> {
    if (!this.#operationRow(operationId)) {
      const now = Date.now();
      this.lifecycle.storage.sql.exec(
        `INSERT OR IGNORE INTO cf_agents_harness_operations
           (operation_id, session_id, status, kind, delivery, input_hash, payload, created_at)
         VALUES (?, ?, 'queued', ?, ?, 'adopted', NULL, ?)`,
        operationId,
        sessionId,
        options.kind,
        options.delivery ?? "queue",
        now
      );
    }
    return this.#begin(sessionId, operationId, options.delivery);
  }

  async #begin(
    sessionId: string,
    operationId: string,
    delivery?: "queue" | "steer"
  ): Promise<HarnessOperationHandle<P>> {
    const row = this.#operationRow(operationId);
    if (!row || row.session_id !== sessionId) {
      throw new HarnessOperationNotFoundError(operationId);
    }
    const existing = this.#operationLogs.get(operationId);
    if (existing && row.status !== "queued") return existing;
    if (row.status === "settled") {
      return new LogWriter<P>(
        this,
        sessionId,
        operationId,
        harnessOperationStreamId(sessionId, operationId),
        undefined
      );
    }
    const log = await this.#operationLog(row);
    if (row.status === "queued") {
      // The frame's seq is known at append; the row records it so a replay
      // from a later cursor can skip this operation's log without reading it.
      const firstSeq = log.append({
        type: "operation_started",
        delivery: delivery ?? row.delivery
      });
      this.lifecycle.storage.transactionSync(() => {
        this.lifecycle.storage.sql.exec(
          `UPDATE cf_agents_harness_operations
           SET status = 'running', started_at = ?, runtime_id = ?, first_seq = ?
           WHERE operation_id = ? AND status = 'queued'`,
          Date.now(),
          this.#runtime.id,
          firstSeq,
          operationId
        );
        // The admission row is consumed by starting; replies and interrupts
        // keyed to this operation stay for the runtime.
        this.lifecycle.storage.sql.exec(
          "DELETE FROM cf_agents_harness_inbox WHERE operation_id = ? AND key = ?",
          operationId,
          operationId
        );
      });
      log.flush();
      this.#transport?.statusChanged(sessionId);
    }
    return log;
  }

  /** Settle an operation, its log, its interrupt rows and its open requests in one transaction. */
  async #settle(
    operationId: string,
    outcome: HarnessSettlement<P>
  ): Promise<void> {
    const row = this.#operationRow(operationId);
    if (!row || row.status === "settled") return;
    const sessionId = row.session_id;
    const log =
      this.#operationLogs.get(operationId) ??
      (row.status === "running"
        ? await this.#operationLog(row)
        : await this.#sessionLog(sessionId));
    const now = Date.now();
    const openRequests = this.#requestRows(sessionId, operationId);
    for (const request of openRequests) {
      await this.lifecycle.jobs.cancel(`rt:${request.request_id}`);
      const recorded = timeoutReply(request.type);
      if (recorded) {
        log.append({
          type: "request_replied",
          requestId: request.request_id,
          reply: recorded,
          by: "lost"
        });
      }
      this.#askWaiters
        .get(request.request_id)
        ?.reject(new HarnessDetachedError("Operation settled"));
      this.#askWaiters.delete(request.request_id);
    }
    const result: HarnessResult<P> = {
      operationId,
      sessionId,
      status: outcome.status,
      stopReason: outcome.stopReason,
      streamId: harnessOperationStreamId(sessionId, operationId),
      cursor: "",
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
      ...(outcome.stillQueued === undefined
        ? {}
        : { stillQueued: outcome.stillQueued }),
      startedAt: row.started_at ?? row.created_at,
      endedAt: now,
      ...(outcome.raw === undefined ? {} : { raw: outcome.raw })
    };
    const lastSeq = log.append({
      type: "operation_settled",
      // SAFETY: HarnessResult<P> is a HarnessResult with a narrower `raw`.
      result: result as HarnessResult
    });
    const settled = { ...result, cursor: this.#cursor(sessionId) };
    this.lifecycle.storage.transactionSync(() => {
      const sql = this.lifecycle.storage.sql;
      sql.exec(
        `UPDATE cf_agents_harness_operations
         SET status = 'settled', settled_at = ?, last_seq = ?, result = ?
         WHERE operation_id = ?`,
        now,
        lastSeq,
        JSON.stringify(settled),
        operationId
      );
      sql.exec(
        "DELETE FROM cf_agents_harness_inbox WHERE operation_id = ? AND kind = 'interrupt'",
        operationId
      );
      sql.exec(
        "DELETE FROM cf_agents_harness_requests WHERE operation_id = ?",
        operationId
      );
      if (log.operationId === operationId) {
        log.settle(outcome.status === "failed" ? "errored" : "completed");
      } else {
        log.flush();
      }
    });
    this.#operationLogs.delete(operationId);
    this.#interrupts.delete(operationId);
    this.lifecycle.events.emit("harness:settled", {
      sessionId,
      operationId,
      status: outcome.status
    });
    this.#notifySettled(operationId);
    this.#transport?.statusChanged(sessionId);
  }

  /** Withdraw a queued operation before it starts. */
  async #decline(row: OperationRow, reason: string): Promise<void> {
    await this.#settle(row.operation_id, {
      status: "declined",
      stopReason: { type: "declined", raw: reason }
    });
  }

  // ── Requests ─────────────────────────────────────────────────────────────

  #openRequest(sessionId: string, draft: HarnessRequestDraft): HarnessRequest {
    const {
      requestId,
      operationId,
      type,
      expiresAt: requested,
      ...payload
    } = draft;
    const now = Date.now();
    const expiresAt = requested ?? now + this.#policy.requestTimeoutMs;
    const existing = this.#requestRow(requestId);
    if (!existing) {
      this.lifecycle.storage.sql.exec(
        `INSERT INTO cf_agents_harness_requests
           (request_id, session_id, operation_id, type, payload, asked_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        requestId,
        sessionId,
        operationId,
        type,
        JSON.stringify(payload),
        now,
        expiresAt
      );
      this.lifecycle.jobs
        .push({
          id: `rt:${requestId}`,
          fn: REQUEST_TIMEOUT_FN,
          time: expiresAt,
          payload: { requestId }
        })
        .catch((error: unknown) => {
          console.error(
            `Harness could not arm the timeout for ${requestId}`,
            error
          );
        });
    }
    const request = this.#toRequest(
      existing ?? (this.#requestRow(requestId) as RequestRow)
    );
    if (!existing) {
      const log =
        this.#operationLogs.get(operationId) ??
        this.#sessionLogs.get(sessionId);
      log?.append({ type: "request_raised", request });
      log?.flush();
      this.#transport?.requestsChanged(sessionId);
    }
    return request;
  }

  #ask(sessionId: string, draft: HarnessRequestDraft): Promise<HarnessReply> {
    const request = this.#openRequest(sessionId, draft);
    // A reply that arrived before this isolate asked again (a redelivery
    // after a wake) is waiting in the inbox.
    const pending = this.#inboxRows(sessionId, ["reply"]).find(
      (row) => row.key === request.requestId
    );
    if (pending) {
      this.#takeInbox(pending.seq);
      const payload = JSON.parse(pending.payload) as {
        reply: HarnessReply;
        by: "client" | "timeout";
      };
      const row = this.#requestRow(request.requestId);
      const closing = row
        ? this.#closeRequest(
            row,
            payload.by === "client" ? "answered" : payload.by,
            payload.reply
          )
        : Promise.resolve();
      return closing.then(() => payload.reply);
    }
    return new Promise<HarnessReply>((resolve, reject) => {
      this.#askWaiters.set(request.requestId, {
        resolve: (reply) => {
          this.#askWaiters.delete(request.requestId);
          resolve(reply);
        },
        reject: (error) => {
          this.#askWaiters.delete(request.requestId);
          reject(error);
        }
      });
    });
  }
}

/** The answer the base writes when nobody else does. */
function timeoutReply(type: string): HarnessReply | undefined {
  switch (type) {
    case "permission":
      return { type: "permission", decision: "deny", message: "timed out" };
    case "question":
      return { type: "question", answers: null, message: "timed out" };
    case "tool":
      return {
        type: "tool",
        output: { error: "timed out" },
        isError: true
      };
    case "extension":
      return {
        type: "extension",
        kind: "timeout",
        payload: { message: "timed out" }
      };
    default:
      return undefined;
  }
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return -1;
  const seq = Number(cursor);
  return Number.isFinite(seq) ? seq : -1;
}

// ── The session handle ────────────────────────────────────────────────────

/** Prototype-only, so it can be served as an RpcTarget unchanged. */
class SessionHandle<P extends HarnessProtocol> implements HarnessSession<P> {
  readonly sessionId: string;
  readonly #harness: Harness<P>;
  #deleted = false;

  constructor(harness: Harness<P>, sessionId: string) {
    this.#harness = harness;
    this.sessionId = sessionId;
  }

  #live(): Harness<P> {
    if (this.#deleted) {
      throw new HarnessClosedError(`Session ${this.sessionId} was deleted`);
    }
    return this.#harness;
  }

  prompt(
    input: HarnessInput,
    options: HarnessPromptOptions = {}
  ): Promise<HarnessReceipt> {
    return this.#live().admit(
      this.sessionId,
      "prompt",
      { input, delivery: options.delivery ?? "queue" },
      options
    );
  }

  interrupt(
    options?: HarnessInterruptOptions
  ): Promise<HarnessInterruptResult> {
    return this.#live().interrupt(this.sessionId, options);
  }

  requests(): Promise<readonly HarnessRequest[]> {
    return this.#live().requests(this.sessionId);
  }

  reply(
    requestId: string,
    reply: HarnessReply
  ): Promise<{ readonly accepted: boolean }> {
    return this.#live().reply(this.sessionId, requestId, reply);
  }

  messages(options?: HarnessMessagesOptions): Promise<HarnessMessagePage> {
    return this.#live().messages(this.sessionId, options);
  }

  status(): Promise<HarnessStatus> {
    return this.#live().status(this.sessionId);
  }

  result(operationId: string): Promise<HarnessResult<P> | undefined> {
    return this.#live().result(this.sessionId, operationId);
  }

  wait(
    operationId: string,
    options?: HarnessWaitOptions
  ): Promise<HarnessResult<P>> {
    return this.#live().wait(this.sessionId, operationId, options);
  }

  events(
    options?: HarnessEventsOptions
  ): AsyncIterable<HarnessEvent<P> | HarnessPreview> {
    return this.#live().events(this.sessionId, options);
  }

  close(): Promise<void> {
    return this.#live().close(this.sessionId);
  }

  async delete(): Promise<void> {
    await this.#live().deleteSession(this.sessionId);
    this.#deleted = true;
  }

  submit(
    submission: P["submit"],
    options: HarnessSubmitOptions = {}
  ): Promise<HarnessReceipt> {
    if (RESERVED_KINDS.has(submission.kind)) {
      throw new HarnessCapabilityUnsupportedError(
        `submit(${submission.kind}): use the dedicated method`
      );
    }
    return this.#live().admit(
      this.sessionId,
      submission.kind,
      submission.payload,
      options
    );
  }

  compact(options: HarnessCompactOptions = {}): Promise<HarnessReceipt> {
    const { operationId, ...payload } = options;
    return this.#live().admit(this.sessionId, "compact", payload, {
      ...(operationId === undefined ? {} : { operationId })
    });
  }

  fork(options: HarnessForkOptions = {}): Promise<HarnessSession<P>> {
    return this.#live().fork(this.sessionId, options);
  }

  rewind(
    toMessageId: string,
    options: HarnessRewindOptions = {}
  ): Promise<HarnessRewindResult> {
    return this.#live().rewind(this.sessionId, toMessageId, options);
  }

  configure(patch: HarnessConfigPatch): Promise<HarnessConfig> {
    return this.#live().configure(this.sessionId, patch);
  }

  cancelQueued(operationId: string): Promise<boolean> {
    return this.#live().cancelQueued(this.sessionId, operationId);
  }
}

export type { HarnessCoreEvent };
