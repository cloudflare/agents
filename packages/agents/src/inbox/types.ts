/**
 * Where a request is. `pending` and `running` are open; the rest are terminal.
 *
 * @internal
 */
export type InboxStatus =
  | "pending"
  | "running"
  | "completed"
  | "error"
  | "aborted"
  | "skipped";

/**
 * The terminal statuses. A record in one of them never changes status again.
 *
 * @internal
 */
export type InboxTerminalStatus = Exclude<InboxStatus, "pending" | "running">;

/**
 * What a request does when it arrives while its lane has an open request.
 *
 * - `queue` waits its turn.
 * - `drop` ends `skipped` at once.
 * - `latest` waits its turn, and ends `skipped` at the front of the lane
 *   when a later overlapping request (`latest`, `merge` or debounce) is
 *   behind it.
 * - `merge` is `latest`, stored as `merge` so the handler knows to fold
 *   the superseded requests ({@link InboxRun.merged}) into its run.
 * - `{ debounceMs }` is `latest` that also waits, at the front of the lane,
 *   until `debounceMs` after it arrived.
 *
 * A request that arrives at an idle lane is never overlapping: it runs as
 * `queue` would, whatever its policy.
 *
 * @internal
 */
export type InboxPolicy =
  | "queue"
  | "latest"
  | "merge"
  | "drop"
  | { readonly debounceMs: number };

/**
 * One request as stored, without its payload. JSON values throughout.
 *
 * @internal
 */
export type InboxRequest<Result = unknown> = {
  readonly id: string;
  /** The handler that runs it. */
  readonly kind: string;
  /** Requests in one lane run one at a time, in {@link seq} order. */
  readonly lane: string;
  /** Arrival order, across every lane. */
  readonly seq: number;
  readonly status: InboxStatus;
  /** How many times a handler has started on it. 0 while it waits. */
  readonly attempt: number;
  readonly policy: "queue" | "latest" | "merge" | "drop" | "debounce";
  readonly idempotencyKey?: string;
  readonly metadata?: Record<string, unknown>;
  /** What the handler recorded with {@link Inbox.checkpoint}. */
  readonly progress?: unknown;
  /** The handler's return value, on `completed`. */
  readonly result?: Result;
  /** Why it ended `error`, `aborted` or `skipped`, when there is a reason. */
  readonly error?: string;
  /** A handler handed it off: it stays `running` until {@link Inbox.settle}. */
  readonly detached: boolean;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly settledAt?: number;
};

/**
 * What a handler is given besides the payload.
 *
 * @internal
 */
export type InboxRun = {
  readonly id: string;
  readonly kind: string;
  readonly lane: string;
  /** 1 on the first run, 2 or more after an interruption. */
  readonly attempt: number;
  /** Aborts on {@link Inbox.cancel}, {@link Inbox.clear} and disposal. */
  readonly signal: AbortSignal;
  readonly metadata?: Record<string, unknown>;
  /** What an earlier attempt recorded with {@link Inbox.checkpoint}. */
  readonly progress?: unknown;
  /** The ids of the requests this one superseded, oldest first. */
  readonly merged: readonly string[];
  /**
   * What the submit attached with `local`, when it was made in this
   * isolate. `undefined` after a reset: the request is replayed from its
   * record alone.
   */
  readonly local: unknown;
};

/**
 * Registered handlers, by kind. Parameters are `never` so any concretely
 * typed handler fits; {@link InboxPayload} recovers a handler's payload.
 *
 * @internal
 */
export type InboxHandlers = Record<
  string,
  (payload: never, run: InboxRun) => unknown
>;

/**
 * The payload a registered handler accepts.
 *
 * @internal
 */
export type InboxPayload<Handler> = Handler extends (
  payload: infer Payload,
  ...rest: never[]
) => unknown
  ? Payload
  : never;

/**
 * Options accepted by {@link Inbox.submit}.
 *
 * @internal
 */
export type InboxSubmitOptions = {
  /** Stable id. Generated when absent. */
  readonly id?: string;
  /**
   * A second stable key. A submit with a key a record already has returns
   * that record when the payload is the same, and throws when it is not.
   */
  readonly idempotencyKey?: string;
  /** The lane it runs in. Defaults to the kind. */
  readonly lane?: string;
  /** What it does when its lane is busy. Default `queue`. */
  readonly policy?: InboxPolicy;
  readonly metadata?: Record<string, unknown>;
  /**
   * Where the lane starts when it is idle. `alarm` (the default) starts it
   * from an alarm due now, so the submit returns before any handler runs.
   * `now` starts it in the calling invocation.
   */
  readonly start?: "alarm" | "now";
  /**
   * A value kept in memory beside the record and handed to the handler as
   * `run.local`, such as a callback that cannot be stored. It does not
   * survive a reset; the handler then runs without it.
   */
  readonly local?: unknown;
};

/**
 * What {@link Inbox.submit} returns.
 *
 * @internal
 */
export type InboxSubmitResult<Result = unknown> = {
  readonly request: InboxRequest<Result>;
  /** `false` when the id or idempotency key matched an existing record. */
  readonly accepted: boolean;
};

/**
 * Filters for {@link Inbox.list}.
 *
 * @internal
 */
export type InboxListOptions = {
  readonly lane?: string;
  readonly kind?: string;
  /** The record with this idempotency key. */
  readonly idempotencyKey?: string;
  readonly status?: InboxStatus | readonly InboxStatus[];
  /** Default 50, at most 500. */
  readonly limit?: number;
  /** Only records created before this epoch-millisecond time. */
  readonly before?: number;
  /** Newest first (the default) or oldest first. */
  readonly order?: "newest" | "oldest";
};

/**
 * Filters for {@link Inbox.purgeBefore}.
 *
 * @internal
 */
export type InboxPurgeOptions = {
  readonly lane?: string;
  readonly kind?: string;
  readonly status?: InboxTerminalStatus | readonly InboxTerminalStatus[];
  /** Delete at most this many, the earliest settled first. */
  readonly limit?: number;
};

/**
 * A record moved from another store, for {@link Inbox.import}.
 *
 * @internal
 */
export type InboxImport = {
  readonly id: string;
  readonly kind: string;
  /** Defaults to the kind. */
  readonly lane?: string;
  readonly status: InboxStatus;
  /** Runs already started. A `running` record needs at least 1. */
  readonly attempt: number;
  readonly idempotencyKey?: string;
  readonly payload?: unknown;
  readonly metadata?: Record<string, unknown>;
  readonly progress?: unknown;
  readonly result?: unknown;
  readonly error?: string;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly settledAt?: number;
};

/**
 * What {@link Inbox.cancel} did.
 *
 * @internal
 */
export type InboxCancelResult = {
  /** The status before the cancel. Terminal means nothing changed. */
  readonly previous: InboxStatus;
  readonly request: InboxRequest;
};

/**
 * Events the Inbox emits.
 *
 * @internal
 */
export type InboxEventType =
  | "inbox:submit"
  | "inbox:status"
  | "inbox:retry"
  | "inbox:error";
