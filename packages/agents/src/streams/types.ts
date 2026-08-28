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
  metadata?: Record<string, StreamJson>;
  /** Reason recorded by `error()`, when the state is `errored`. */
  error?: string;
  createdAt: number;
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
  close(): void;

  /** Settle the stream as errored. No-op if already terminal. */
  error(reason?: string): void;
}

/** Options accepted by `Streams.open()`. */
export interface StreamOpenOptions {
  /** JSON metadata retained with the stream. */
  metadata?: Record<string, StreamJson>;
}

/** Options accepted by `Streams.read()`. */
export interface StreamReadOptions {
  /** First sequence number to yield (inclusive). Defaults to 0. */
  from?: number;
  /** Abort a read that is tailing a live stream. */
  signal?: AbortSignal;
}

/** Filters accepted by `Streams.list()`. */
export interface StreamListOptions {
  state?: StreamState | StreamState[];
  limit?: number;
}

/** @internal Raw `cf_agents_streams` SQLite row. */
export type StreamRow = {
  stream_id: string;
  state: StreamState;
  metadata: string | null;
  error_message: string | null;
  chunk_count: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
};

/** @internal Raw `cf_agents_stream_chunks` SQLite row. */
export type StreamChunkRow = {
  stream_id: string;
  seq: number;
  chunk: string;
  created_at: number;
};
