/**
 * Replayable, sequenced outbound events for the WebSockets capability.
 *
 * An `EventLog` numbers every event it publishes, stores it, and sends it
 * to the connections following the log. A client that reconnects says the
 * last seq it applied; the log replays what it still holds after that, or
 * tells the client to resync from a snapshot when it cannot.
 *
 * It stores nothing of its own: a log is one stream (`log:<name>`) of the
 * host's `Streams` capability, which batches, trims and survives restarts.
 * Event seq n is chunk n - 1 of that stream. See design/event-log.md.
 */

import type { Connection } from "../lifecycle";
import type { Streams, StreamsSyncInternal } from "../streams/streams";
import {
  CF_EVENT_LOGS_KEY,
  getConnectionFlag,
  setConnectionFlag
} from "./connection-flags";
import {
  EVENT_LOG_ERROR,
  EVENT_LOG_EVENTS,
  EVENT_LOG_RESYNC,
  EVENT_LOG_SYNCED,
  type EventLogCursor
} from "./event-log-protocol";

/**
 * Default ceiling for one serialized event (1 MiB).
 *
 * @internal
 */
export const DEFAULT_MAX_EVENT_BYTES = 1_048_576;
/** Highest `maxEventBytes` a log accepts: one event must fit one row. */
const MAX_EVENT_BYTES_LIMIT = 1_900_000;
/** Events per replay frame. */
const REPLAY_PAGE_EVENTS = 100;
const MAX_LOG_NAME_LENGTH = 128;

const DEFAULT_RETENTION_EVENTS = 1000;
const DEFAULT_RETENTION_BYTES = 4 * 1024 * 1024;
const DEFAULT_BATCH_EVENTS = 10;
const DEFAULT_BATCH_BYTES = 256 * 1024;
const DEFAULT_BATCH_DELAY_MS = 250;

const utf8 = new TextEncoder();

/**
 * Options for one event log.
 *
 * @internal Not a public API (sibling-package support through `agents/internal`).
 */
export interface EventLogOptions<S = unknown> {
  /** The host's `Streams` capability: the log is one of its streams. */
  readonly streams: Streams;
  /**
   * How much history the log keeps for replay. After every write the
   * stream's oldest blocks are deleted while either limit is exceeded; the
   * newest block is always kept, so a seq is never reused. A client whose
   * cursor falls before the oldest kept event gets a resync.
   */
  readonly retention?: {
    /** Events kept. Default 1000. */
    readonly maxEvents?: number;
    /** Serialized bytes kept. Default 4 MiB. */
    readonly maxBytes?: number;
  };
  /**
   * When a batch (see {@link EventLog.batch}) writes its buffered events.
   * A crash loses what is still buffered: at most `maxEvents - 1` events,
   * and at most `maxDelayMs` of output. The next isolate starts its seqs
   * `maxEvents` past the stored ones, so a lost seq is never given to a new
   * event, and a client whose cursor is one of them resyncs.
   */
  readonly batching?: {
    /** Buffered events that force a write. Default 10. */
    readonly maxEvents?: number;
    /** Buffered bytes that force a write. Default 256 KiB. */
    readonly maxBytes?: number;
    /** Longest an event stays buffered. Default 250 ms. */
    readonly maxDelayMs?: number;
  };
  /**
   * Ceiling for one serialized event. `publish` and `append` throw for a
   * larger one before assigning it a seq. Default 1 MiB; at most 1.9 MB.
   */
  readonly maxEventBytes?: number;
  /**
   * The state a client rebuilds from when its cursor cannot be replayed:
   * its first subscription, a trimmed or unknown cursor, or events a crash
   * lost. Runs synchronously in the same block that reads the log's head,
   * so the snapshot and the resync's `seq` agree. Must return JSON.
   * Without it, the resync frame carries no snapshot and the client
   * fetches its own.
   */
  readonly snapshot?: (connection: Connection) => S;
  /** Decide whether a connection may follow this log. Default: every one. */
  readonly canSubscribe?: (connection: Connection) => boolean;
}

/** One event as it is sent: seq and serialized entry. */
type Entry = { readonly seq: number; readonly json: string };

/**
 * What the log needs from the WebSockets capability.
 *
 * @internal
 */
export type EventLogHost = {
  readonly connections: () => Iterable<Connection>;
};

function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`Expected a positive number, got ${value}`);
  }
  return value;
}

/**
 * The logs a connection follows, from its hibernation attachment.
 *
 * @internal
 */
export function followedLogs(connection: Connection): readonly string[] {
  const value = getConnectionFlag(connection, CF_EVENT_LOGS_KEY);
  return Array.isArray(value) ? (value as string[]) : [];
}

function setFollowed(connection: Connection, logs: readonly string[]): void {
  setConnectionFlag(
    connection,
    CF_EVENT_LOGS_KEY,
    logs.length > 0 ? [...logs] : undefined
  );
}

function trySend(connection: Connection, text: string): void {
  try {
    connection.send(text);
  } catch {
    // The socket closed between the wake and the send.
  }
}

/**
 * A producer handle for high-rate events, such as model token chunks.
 * Each `append` gets its seq and is sent at once, and is stored with the
 * next write of the log's buffer.
 *
 * @internal Not a public API (sibling-package support through `agents/internal`).
 */
export interface EventLogBatch<T = unknown> {
  /** Assign the next seq, send the event now, store it at the next write. */
  append(data: T): number;
  /** Write the buffered events now. */
  flush(): void;
  /** Write what is buffered and end the batch. Idempotent. */
  close(): void;
}

/**
 * A named, sequenced, replayable stream of outbound events. Create one
 * with `WebSockets.log()`.
 *
 * - `publish(data)` stores the event, then sends it.
 * - `batch()` returns a handle whose `append(data)` sends at once and
 *   stores in batches.
 *
 * Clients follow a log with `followEventLog()` from `agents/client`, or
 * `useEventLog()` from `agents/react`.
 *
 * @internal Not a public API (sibling-package support through `agents/internal`).
 */
export class EventLog<T = unknown, S = unknown> {
  readonly name: string;
  readonly #host: EventLogHost;
  readonly #streamsCapability: Streams;
  readonly #streamId: string;
  readonly #retention: { maxChunks: number; maxBytes: number };
  readonly #batching: { maxChunks: number; maxBytes: number };
  readonly #batchDelayMs: number;
  readonly #maxEventBytes: number;
  readonly #snapshot: ((connection: Connection) => S) | undefined;
  readonly #canSubscribe: ((connection: Connection) => boolean) | undefined;

  /** The stream's epoch, read or written once per isolate. */
  #epoch: string | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  /** @internal Use `declareEventLog()`. */
  constructor(name: string, options: EventLogOptions<S>, host: EventLogHost) {
    if (name.length === 0 || name.length > MAX_LOG_NAME_LENGTH) {
      throw new RangeError(
        `Event log names must be 1 to ${MAX_LOG_NAME_LENGTH} characters`
      );
    }
    this.name = name;
    this.#host = host;
    this.#streamsCapability = options.streams;
    this.#streamId = `log:${name}`;
    this.#retention = {
      maxChunks: positive(
        options.retention?.maxEvents,
        DEFAULT_RETENTION_EVENTS
      ),
      maxBytes: positive(options.retention?.maxBytes, DEFAULT_RETENTION_BYTES)
    };
    this.#batching = {
      maxChunks: Math.floor(
        positive(options.batching?.maxEvents, DEFAULT_BATCH_EVENTS)
      ),
      maxBytes: positive(options.batching?.maxBytes, DEFAULT_BATCH_BYTES)
    };
    this.#batchDelayMs = positive(
      options.batching?.maxDelayMs,
      DEFAULT_BATCH_DELAY_MS
    );
    this.#maxEventBytes = Math.min(
      positive(options.maxEventBytes, DEFAULT_MAX_EVENT_BYTES),
      MAX_EVENT_BYTES_LIMIT
    );
    this.#snapshot = options.snapshot;
    this.#canSubscribe = options.canSubscribe;
  }

  /** The log's epoch and the last seq assigned (0 before the first event). */
  get head(): EventLogCursor {
    const epoch = this.#open();
    return { epoch, seq: this.#streams.bounds(this.#streamId).head };
  }

  /**
   * Store one event, then send it to every connection following the log.
   * Anything a batch has buffered is stored first, so the log keeps seq
   * order. Returns the event's seq.
   */
  publish(data: T): number {
    const entry = this.#append(data);
    this.#flush();
    this.#broadcast(entry);
    return entry.seq;
  }

  /**
   * Open a batch for a high-rate producer: each `append` gets its seq and
   * is sent at once, and is stored with the next write of the log's
   * buffer (`maxEvents`, `maxBytes`, or after `maxDelayMs`).
   */
  batch(): EventLogBatch<T> {
    let closed = false;
    return {
      append: (data: T) => {
        if (closed) throw new Error("This event log batch is closed");
        const entry = this.#append(data);
        this.#broadcast(entry);
        this.#armTimer();
        return entry.seq;
      },
      flush: () => this.#flush(),
      close: () => {
        if (closed) return;
        closed = true;
        this.#flush();
      }
    };
  }

  /**
   * Forget the log's history: delete the stream, start a new epoch at seq
   * 0, and resync every follower (from the snapshot, which should reflect
   * what replaced the history). A client holding a cursor from before can
   * no longer replay anything, and the deleted events are gone from
   * storage. Buffered events are dropped with the stream.
   */
  reset(): void {
    this.#open();
    this.#streams.deleteUnchecked(this.#streamId);
    this.#epoch = undefined;
    this.#open();
    for (const connection of this.#followers()) {
      if (!this.#sendResync(connection)) this.unsubscribe(connection);
    }
  }

  // ── Subscriptions ──────────────────────────────────────────────────────

  /**
   * @internal Answer a subscribe frame: replay after the cursor, or
   * resync. Runs synchronously from reading the head to marking the
   * connection subscribed, so no event falls between replay and live.
   */
  subscribe(
    connection: Connection,
    cursor: EventLogCursor | undefined,
    id?: string
  ): void {
    // A refusal (or a failed snapshot below) leaves an earlier
    // subscription on this connection as it was: both are decided per
    // connection, so a socket already following was allowed before.
    if (this.#canSubscribe && !this.#canSubscribe(connection)) {
      this.#sendError(connection, "Subscription refused", id);
      return;
    }
    const epoch = this.#open();
    if (cursor && cursor.epoch === epoch && this.#canReplay(cursor.seq)) {
      this.#replay(connection, cursor.seq, id);
      trySend(
        connection,
        JSON.stringify({
          type: EVENT_LOG_SYNCED,
          log: this.name,
          epoch,
          seq: this.#streams.bounds(this.#streamId).head,
          ...(id !== undefined && { id })
        })
      );
    } else if (!this.#sendResync(connection, id)) {
      return;
    }
    const logs = followedLogs(connection);
    if (!logs.includes(this.name))
      setFollowed(connection, [...logs, this.name]);
  }

  /** @internal Stop sending this log's events to a connection. */
  unsubscribe(connection: Connection): void {
    const logs = followedLogs(connection);
    if (logs.includes(this.name)) {
      setFollowed(
        connection,
        logs.filter((log) => log !== this.name)
      );
    }
  }

  /**
   * @internal Ids of the open connections following this log, so a host
   * can send the same frames the old way to connections that do not.
   */
  followerIds(): string[] {
    return this.#followers().map((connection) => connection.id);
  }

  /** @internal Stop the flush timer; called when the host is destroyed. */
  dispose(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Whether events after cursor `seq` can be replayed: it is not ahead of
   * the head, not before the oldest kept event, and is an event that was
   * stored (a cursor in a hole saw an event a crash lost).
   */
  #canReplay(seq: number): boolean {
    const { oldest, head } = this.#streams.bounds(this.#streamId);
    if (seq < 0 || seq > head) return false;
    // Nothing applied yet: replayable while the log still holds its first
    // chunk (a log whose first chunks a crash lost starts past 0).
    if (seq === 0) return oldest === 0;
    // Chunk `seq - 1` is event `seq`; replay starts at the next one.
    if (seq < oldest) return false;
    if (seq === oldest) return true;
    return this.#streams.holds(this.#streamId, seq - 1);
  }

  #replay(connection: Connection, after: number, id?: string): void {
    // Buffered events are written first, so the replay reads them too.
    this.#flush();
    const prefix = `{"type":"${EVENT_LOG_EVENTS}","log":${JSON.stringify(
      this.name
    )},${id === undefined ? "" : `"id":${JSON.stringify(id)},`}"events":`;
    let from = after;
    for (;;) {
      const rows = this.#streams.readChunks(
        this.#streamId,
        from,
        REPLAY_PAGE_EVENTS
      );
      if (rows.length === 0) break;
      const entries = rows.map(
        (row) => `{"seq":${row.seq + 1},"data":${row.chunk}}`
      );
      trySend(connection, `${prefix}[${entries.join(",")}]}`);
      from = rows[rows.length - 1].seq + 1;
    }
  }

  /** Send a resync with the host's snapshot. Returns false when it failed. */
  #sendResync(connection: Connection, id?: string): boolean {
    const epoch = this.#open();
    const seq = this.#streams.bounds(this.#streamId).head;
    let snapshot: S | undefined;
    try {
      snapshot = this.#snapshot?.(connection);
    } catch (error) {
      console.error(`[EventLog] snapshot for "${this.name}" threw:`, error);
      this.#sendError(connection, "Snapshot failed", id);
      return false;
    }
    let text: string;
    try {
      text = JSON.stringify({
        type: EVENT_LOG_RESYNC,
        log: this.name,
        epoch,
        seq,
        ...(snapshot !== undefined && { snapshot }),
        ...(id !== undefined && { id })
      });
    } catch (error) {
      console.error(
        `[EventLog] snapshot for "${this.name}" is not JSON:`,
        error
      );
      this.#sendError(connection, "Snapshot failed", id);
      return false;
    }
    trySend(connection, text);
    return true;
  }

  #sendError(connection: Connection, error: string, id?: string): void {
    trySend(
      connection,
      JSON.stringify({
        type: EVENT_LOG_ERROR,
        log: this.name,
        error,
        ...(id !== undefined && { id })
      })
    );
  }

  #followers(): Connection[] {
    const followers: Connection[] = [];
    for (const connection of this.#host.connections()) {
      if (followedLogs(connection).includes(this.name)) {
        followers.push(connection);
      }
    }
    return followers;
  }

  #broadcast(entry: Entry): void {
    const text = `{"type":"${EVENT_LOG_EVENTS}","log":${JSON.stringify(
      this.name
    )},"events":[${entry.json}]}`;
    for (const connection of this.#followers()) trySend(connection, text);
  }

  // ── Storage (the stream) ───────────────────────────────────────────────

  get #streams(): StreamsSyncInternal {
    return this.#streamsCapability.__DO_NOT_USE_WILL_BREAK__sync();
  }

  /** Make sure the stream exists; returns its epoch. Once per isolate. */
  #open(): string {
    if (this.#epoch !== undefined) return this.#epoch;
    const streams = this.#streams;
    streams.ensureTables();
    const row = streams.getStream(this.#streamId);
    const stored: unknown = row?.metadata
      ? (JSON.parse(row.metadata) as { epoch?: unknown }).epoch
      : undefined;
    let epoch: string;
    if (typeof stored === "string") {
      epoch = stored;
    } else {
      epoch = crypto.randomUUID();
      if (row) streams.setMetadata(this.#streamId, { epoch });
      else streams.insertStream(this.#streamId, null, { epoch });
    }
    this.#epoch = epoch;
    return epoch;
  }

  /** Number one event and add it to the buffer; throws before a seq. */
  #append(data: T): Entry {
    this.#open();
    const dataJson = JSON.stringify(data);
    if (dataJson === undefined) {
      throw new TypeError("Event log data must be a JSON value");
    }
    const bytes = utf8.encode(dataJson).byteLength;
    if (bytes > this.#maxEventBytes) {
      throw new RangeError(
        `Event of ${bytes} bytes exceeds the ${this.#maxEventBytes}-byte limit of event log "${this.name}"`
      );
    }
    const seq =
      this.#streams.append(this.#streamId, data as never, this.#batching) + 1;
    return { seq, json: `{"seq":${seq},"data":${dataJson}}` };
  }

  /** Write the buffer, then trim to retention. */
  #flush(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#streams.flush(this.#streamId);
    this.#streams.trim(this.#streamId, this.#retention);
  }

  #armTimer(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      try {
        this.#flush();
      } catch (error) {
        console.error(`[EventLog] flush of "${this.name}" failed:`, error);
      }
    }, this.#batchDelayMs);
  }
}
