import type { RetryOptions } from "../retries";

/**
 * One durable background task waiting in a Queue.
 *
 * @template T Type of the callback payload.
 */
export type QueueItem<T = unknown> = {
  /** Unique item identifier. */
  id: string;
  /** Name of the callback invoked with the payload. */
  callback: string;
  /** Data passed to the callback. */
  payload: T;
  /** Creation time as a Unix timestamp in seconds. */
  createdAt: number;
  /** Retry policy applied when the callback throws. */
  retry?: RetryOptions;
};

/**
 * Constraint for a Queue's registered callback map: named handlers receiving
 * the parsed payload and the item being processed.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type QueueHandlers = Record<
  string,
  // Parameters are `never` so any concretely-typed handler satisfies the
  // constraint under contravariance; each handler's real parameter types are
  // recovered with `QueuePayload`.
  (payload: never, item: never) => unknown
>;

/**
 * Default callback surface for a Queue constructed without registered
 * callbacks: any name compiles with an untyped payload. At runtime a name
 * must be registered or supplied by a composition-root resolver (the
 * aperture behind Agent's name-based queue API); a bare Queue rejects it
 * otherwise.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type QueueCallbacks = Record<
  string,
  (payload: unknown, item: QueueItem<unknown>) => unknown
>;

/**
 * The payload type a registered queue callback accepts.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type QueuePayload<Handler> = Handler extends (
  payload: infer Payload,
  ...rest: never[]
) => unknown
  ? Payload
  : never;

/** Options accepted when pushing one item. */
export type QueuePushOptions = {
  /**
   * Stable item id. A push with an existing id replaces that item in place
   * (and supersedes a dispatch of it that is still in flight). Omitted ids
   * are generated.
   */
  id?: string;
  /** Retry policy for callback execution, overriding the Queue default. */
  retry?: RetryOptions;
};

/** Filters accepted by `list()`. */
export type QueueCriteria = {
  /** Only items addressed to this callback. */
  callback?: string;
};

/** @internal Raw legacy `cf_agents_queues` SQLite row. */
export type QueueStorageRow = {
  id: string;
  payload: string | null;
  callback: string;
  created_at: number;
  retry_options?: string | null;
};
