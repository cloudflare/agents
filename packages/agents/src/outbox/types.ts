/** Where a delivery stands. Acknowledged deliveries are deleted. */
export type OutboxDeliveryStatus = "pending" | "held" | "failed";

/**
 * How a sink's failed deliveries back off and when they give up.
 *
 * Attempt `n` (1-based) that fails waits `min(maxDelayMs, baseDelayMs *
 * 2^(n-1))` before the next one. Delivery gives up after `maxAttempts`
 * attempts, or when the next attempt would start more than `giveUpAfterMs`
 * after the first.
 */
export type OutboxRetryPolicy = {
  /**
   * How long one attempt may run before it counts as failed. The sink keeps
   * running; if it returns later the value is still acknowledged. Default:
   * 60 seconds.
   */
  readonly attemptTimeoutMs?: number;
  /** Wait after the first failed attempt. Default: 2 seconds. */
  readonly baseDelayMs?: number;
  /** Longest wait between two attempts. Default: 10 minutes. */
  readonly maxDelayMs?: number;
  /** Attempts before giving up. Default: unlimited. */
  readonly maxAttempts?: number;
  /** How long after the first attempt delivery keeps trying. Default: 12 hours. */
  readonly giveUpAfterMs?: number;
};

/** One delivery as stored. */
export type OutboxDelivery<T = unknown> = {
  /** Stable id of the delivery; kept when its value is replaced. */
  readonly id: string;
  /** The sink the delivery is addressed to. */
  readonly sink: string;
  /** The key within the sink. A send to the same key replaces the value. */
  readonly key: string;
  /**
   * New for every `send()`, stable across the retries of that value. Pass
   * it downstream so the receiver can drop a repeat.
   */
  readonly idempotencyKey: string;
  /** The value waiting to be delivered. */
  readonly payload: T;
  readonly status: OutboxDeliveryStatus;
  /** Attempts made for this value. */
  readonly attempts: number;
  /** Epoch ms of the first attempt for this value, or null before it. */
  readonly firstAttemptAt: number | null;
  /** Epoch ms of the next attempt, or null when held or failed. */
  readonly nextAt: number | null;
  /** Message of the last failed attempt, cut at 4,000 characters. */
  readonly lastError: string | null;
  /**
   * Counts the values sent under this key, starting at 1. A receiver that
   * can see two attempts of one key (an attempt that timed out and returned
   * late) keeps the higher version.
   */
  readonly version: number;
  /** Epoch ms the key was first sent. */
  readonly createdAt: number;
  /** Epoch ms of the last change. */
  readonly updatedAt: number;
};

/** What a sink gets with each attempt. */
export type OutboxDeliveryContext = {
  readonly id: string;
  readonly sink: string;
  readonly key: string;
  readonly idempotencyKey: string;
  /** The value's version under its key; see {@link OutboxDelivery.version}. */
  readonly version: number;
  /** 1-based attempt for this value. */
  readonly attempt: number;
  /** What the sink last saved for this value, or undefined. */
  readonly checkpoint: unknown;
  /**
   * Durably record progress inside this value (for a value delivered in
   * several steps). The next attempt reads it back as `checkpoint`. A new
   * value clears it. At most 256 KB of JSON; past that it throws, which
   * fails the attempt.
   */
  readonly saveCheckpoint: (value: unknown) => Promise<void>;
};

/**
 * Where deliveries go. `deliver` returning acknowledges the value; throwing
 * fails the attempt.
 */
export type OutboxSink<T = unknown> = {
  readonly deliver: (
    payload: T,
    delivery: OutboxDeliveryContext
  ) => void | Promise<void>;
  /** This sink's retry policy, over the Outbox default. */
  readonly retry?: OutboxRetryPolicy;
  /** Runs once when a delivery gives up; the delivery is then `failed`. */
  readonly onGiveUp?: (
    payload: T,
    delivery: OutboxDelivery<T>,
    error: unknown
  ) => void | Promise<void>;
};

/**
 * Constraint for a sink map. The payload is `never` so a concretely typed
 * sink satisfies the map; {@link OutboxPayload} recovers it.
 */
export type OutboxSinks = Record<string, OutboxSink<never>>;

/** The payload type a sink accepts. */
export type OutboxPayload<Sink> =
  Sink extends OutboxSink<infer Payload> ? Payload : never;

/** Options for one `send()`. */
export type OutboxSendOptions = {
  /** The key. Default: a new unique key, so every send is its own delivery. */
  readonly key?: string;
  /** Store the value without delivering it; a later send releases it. */
  readonly hold?: boolean;
  /** Retry policy for this delivery, over the sink's. */
  readonly retry?: OutboxRetryPolicy;
};

/** Filters for `list()`. */
export type OutboxListOptions = {
  readonly sink?: string;
  readonly status?: OutboxDeliveryStatus | OutboxDeliveryStatus[];
};

/** Events the Outbox emits. */
export type OutboxEventType =
  | "outbox:send"
  | "outbox:deliver"
  | "outbox:retry"
  | "outbox:give_up";

/** Options for an Outbox capability. */
export type OutboxOptions<Sinks extends OutboxSinks = OutboxSinks> = {
  /** Named sinks. Registered on every wake, so pending deliveries resolve. */
  readonly sinks?: Sinks;
  /** Default retry policy for every sink. */
  readonly retry?: OutboxRetryPolicy;
};
