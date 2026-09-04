/**
 * JSON-serializable data accepted as stream chunks and metadata.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type StreamJson =
  | string
  | number
  | boolean
  | null
  | StreamJson[]
  | { [key: string]: StreamJson };

/**
 * States a stream moves through. A stream is `streaming` from `open()` until
 * its producer settles it; both terminal states keep the chunk log readable.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type StreamState = "streaming" | "completed" | "errored";

/**
 * One durable chunk. `seq` is the stream's monotonic cursor: 0-based,
 * assigned at append time, and stable across replays.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface StreamChunk {
  readonly seq: number;
  readonly chunk: StreamJson;
}

/**
 * Read-only status of one stream — the recovery-evidence surface a Task's
 * `recover` callback consults.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface StreamStatus {
  streamId: string;
  state: StreamState;
  /** The next sequence number to be assigned == durable chunk count. */
  cursor: number;
  /** Application lookup key assigned at `open()`, when one was. */
  tag?: string;
  metadata?: Record<string, StreamJson>;
  /** Reason recorded by `error()`, when the state is `errored`. */
  error?: string;
  createdAt: number;
  /**
   * Last write activity: advances with every append and with settlement.
   * The liveness signal retention policies key off — a `streaming` stream
   * whose `updatedAt` is old has a producer that stopped appending. (For a
   * live stream this is derived from the chunk log's newest entry; the
   * stored row is only stamped at open and settle.)
   */
  updatedAt: number;
  closedAt?: number;
}

/**
 * Producer handle returned by `Streams.open()`. Appends are synchronous
 * durable writes; a terminal stream rejects further appends.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface StreamWriter {
  readonly streamId: string;

  /** The next sequence number to be assigned. */
  readonly cursor: number;

  /** Durably append one chunk and wake live readers. Returns its `seq`. */
  append(chunk: StreamJson): number;

  /** Settle the stream as completed. No-op if already terminal. */
  close(options?: StreamSettleOptions): void;

  /** Settle the stream as errored. No-op if already terminal. */
  error(reason?: string, options?: StreamSettleOptions): void;
}

/**
 * The cutover: settle a stream, run the caller's own synchronous writes
 * (typically persisting the finished message), and discard the stream's
 * rows, all in ONE SQLite transaction. A crash leaves either the live
 * stream or the finished message, never neither. `commit` must not await
 * and must not throw for a reason it wants ignored: a throw rolls the
 * settle back and leaves the stream live.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface StreamSettleOptions {
  /** Synchronous writes to commit with the settlement. */
  readonly commit?: () => void;
  /**
   * Delete the stream's rows in the same transaction. The stream ceases
   * to exist (`status()` returns null); readers tailing it end. Use when
   * the chunks have been handed off, so nothing is left to sweep later.
   */
  readonly discard?: boolean;
}

/** Options accepted by `Streams.open()`. */
export interface StreamOpenOptions {
  /** JSON metadata retained with the stream. */
  metadata?: Record<string, StreamJson>;
  /**
   * Indexed application lookup key, set once at creation. Deliberately not
   * unique: an operation that produces successive streams (a retried turn, a
   * regenerated reply) stamps each with the same tag, and
   * `list({ tag, limit: 1 })` finds the latest. Reopening a live stream with
   * a *different* tag throws — a config conflict, not a new stream.
   */
  tag?: string;
}

/** Options accepted by `Streams.read()`. */
export interface StreamReadOptions {
  /** First sequence number to yield (inclusive). Defaults to 0. */
  from?: number;
  /** Abort a read that is tailing a live stream. */
  signal?: AbortSignal;
}

/** Options accepted by `Streams.readBatches()`. */
export interface StreamReadBatchesOptions extends StreamReadOptions {
  /** Maximum chunks per yielded batch. Defaults to 100. */
  batchSize?: number;
  /**
   * Invoked once, the first time the reader reaches the durable tail —
   * i.e. every chunk stored so far has been yielded. Distinct from the
   * stream ending: a live stream is "up to date" while tailing. Useful as a
   * transition signal (flush replayed UI, show a live indicator).
   */
  onUpToDate?: () => void;
}

/** Filters accepted by `Streams.list()`. */
export interface StreamListOptions {
  state?: StreamState | StreamState[];
  /** Only streams opened with this exact tag (indexed). */
  tag?: string;
  limit?: number;
}

/**
 * @internal Raw `cf_agents_streams` SQLite row.
 *
 * While `state` is `streaming`, `chunk_count` and `updated_at` are NOT
 * maintained per append (appends write only the chunk log; the log's tail
 * is authoritative — see `Streams.#tail`). Both are stamped exact by the
 * settle UPDATE, so terminal rows read straight through. Consumers of a
 * live row must derive cursor/liveness rather than trust these columns.
 */
export type StreamRow = {
  stream_id: string;
  state: StreamState;
  tag: string | null;
  metadata: string | null;
  error_message: string | null;
  chunk_count: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
};

/** @internal One chunk as read back from a `cf_agents_stream_blocks` row. */
export type StreamChunkRow = {
  stream_id: string;
  seq: number;
  chunk: string;
  created_at: number;
};
