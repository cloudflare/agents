/**
 * Replayable, sequenced outbound events for the WebSockets capability.
 *
 * An `EventLog` numbers every event it publishes, stores it, and sends it
 * to the connections following the log. A client that reconnects says the
 * last seq it applied; the log replays what it still holds after that, or
 * tells the client to resync from a snapshot when it cannot.
 *
 * Storage is two tables owned by the WebSockets capability:
 * `cf_agents_event_logs` (one row per log: its epoch) and
 * `cf_agents_event_log_rows` (batches of whole events, plus gap rows that
 * mark seqs a crash lost). See design/event-log.md for the contract.
 */

import type { Connection } from "../lifecycle";
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

/** Default ceiling for one serialized event (1 MiB). */
export const DEFAULT_MAX_EVENT_BYTES = 1_048_576;
/** Highest `maxEventBytes` a log accepts: one event must fit one row. */
const MAX_EVENT_BYTES_LIMIT = 1_900_000;
/**
 * A stored row closes before its body passes this many bytes; a larger
 * event is stored alone. Well under SQLite's 2 MB row limit, and one row
 * is one replay frame.
 */
const ROW_MAX_BYTES = 512 * 1024;
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
 * @experimental The API surface may change before stabilizing.
 */
export interface EventLogOptions<S = unknown> {
  /**
   * How much history the log keeps for replay. After every write the
   * oldest batches are deleted while either limit is exceeded; the newest
   * batch is always kept, so a seq is never reused. A client whose cursor
   * falls before the oldest kept event gets a resync.
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
   * and at most `maxDelayMs` of output.
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

/** One event as it waits in the batch buffer: seq and serialized entry. */
type Entry = { readonly seq: number; readonly json: string; bytes: number };

/** Per-isolate view of the log's stored rows, read once on first use. */
type Loaded = {
  readonly epoch: string;
  /** Last seq assigned, buffered events included. 0 when none yet. */
  head: number;
  /** First retained seq, or null when the log has no rows. */
  oldest: number | null;
  rows: number;
  events: number;
  bytes: number;
  /** Whether the newest row carries `open_until`. */
  newestOpen: boolean;
};

type Row = {
  seq_from: number;
  seq_to: number;
  kind: "events" | "gap";
  body: string;
  bytes: number;
};

/** What the log needs from the WebSockets capability. */
export type EventLogHost = {
  readonly sql: () => SqlStorage;
  readonly connections: () => Iterable<Connection>;
  readonly emit: (type: string, payload: Record<string, unknown>) => void;
};

/** Storage handles whose tables exist, so DDL runs once per isolate. */
const tablesReady = new WeakSet<SqlStorage>();

function ensureTables(sql: SqlStorage): void {
  if (tablesReady.has(sql)) return;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS cf_agents_event_logs (
      log TEXT PRIMARY KEY,
      epoch TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS cf_agents_event_log_rows (
      log TEXT NOT NULL,
      seq_from INTEGER NOT NULL,
      seq_to INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('events', 'gap')),
      body TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      open_until INTEGER,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (log, seq_from)
    ) WITHOUT ROWID`);
  tablesReady.add(sql);
}

function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`Expected a positive number, got ${value}`);
  }
  return value;
}

/** The logs a connection follows, from its hibernation attachment. */
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
 * @experimental The API surface may change before stabilizing.
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
 * @experimental The API surface may change before stabilizing.
 */
export class EventLog<T = unknown, S = unknown> {
  readonly name: string;
  readonly #host: EventLogHost;
  readonly #retentionEvents: number;
  readonly #retentionBytes: number;
  readonly #batchEvents: number;
  readonly #batchBytes: number;
  readonly #batchDelayMs: number;
  readonly #maxEventBytes: number;
  readonly #snapshot: ((connection: Connection) => S) | undefined;
  readonly #canSubscribe: ((connection: Connection) => boolean) | undefined;

  #loaded: Loaded | undefined;
  #buffer: Entry[] = [];
  #bufferBytes = 0;
  #openBatches = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  /** @internal Use `WebSockets.log()`. */
  constructor(name: string, options: EventLogOptions<S>, host: EventLogHost) {
    if (name.length === 0 || name.length > MAX_LOG_NAME_LENGTH) {
      throw new RangeError(
        `Event log names must be 1 to ${MAX_LOG_NAME_LENGTH} characters`
      );
    }
    this.name = name;
    this.#host = host;
    this.#retentionEvents = positive(
      options.retention?.maxEvents,
      DEFAULT_RETENTION_EVENTS
    );
    this.#retentionBytes = positive(
      options.retention?.maxBytes,
      DEFAULT_RETENTION_BYTES
    );
    this.#batchEvents = Math.floor(
      positive(options.batching?.maxEvents, DEFAULT_BATCH_EVENTS)
    );
    this.#batchBytes = positive(
      options.batching?.maxBytes,
      DEFAULT_BATCH_BYTES
    );
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
    const loaded = this.#load();
    return { epoch: loaded.epoch, seq: loaded.head };
  }

  /**
   * Store one event, then send it to every connection following the log.
   * Anything a batch has buffered is stored first, so the log keeps seq
   * order. Returns the event's seq.
   */
  publish(data: T): number {
    const entry = this.#entry(data);
    this.#buffer.push(entry);
    this.#bufferBytes += entry.bytes;
    this.#flush();
    this.#broadcast([entry]);
    return entry.seq;
  }

  /**
   * Open a batch for a high-rate producer. Its first `append` is stored at
   * once and marks the log open, so a crash before `close()` is detected
   * on the next start: the seqs that may have been sent but not stored
   * become a gap, and clients that saw them resync.
   */
  batch(): EventLogBatch<T> {
    let first = true;
    let closed = false;
    this.#openBatches += 1;
    return {
      append: (data: T) => {
        if (closed) throw new Error("This event log batch is closed");
        const entry = this.#entry(data);
        this.#buffer.push(entry);
        this.#bufferBytes += entry.bytes;
        this.#broadcast([entry]);
        if (
          first ||
          this.#buffer.length >= this.#batchEvents ||
          this.#bufferBytes >= this.#batchBytes
        ) {
          this.#flush();
        } else {
          this.#armTimer();
        }
        first = false;
        return entry.seq;
      },
      flush: () => this.#flush(),
      close: () => {
        if (closed) return;
        closed = true;
        this.#openBatches -= 1;
        this.#flush();
      }
    };
  }

  // ── Subscriptions ──────────────────────────────────────────────────────

  /**
   * @internal Answer a subscribe frame: replay after the cursor, or
   * resync. Runs synchronously from reading the head to marking the
   * connection subscribed, so no event falls between replay and live.
   */
  subscribe(connection: Connection, cursor: EventLogCursor | undefined): void {
    if (this.#canSubscribe && !this.#canSubscribe(connection)) {
      this.#sendError(connection, "Subscription refused");
      return;
    }
    const loaded = this.#load(connection);
    if (cursor && this.#canReplay(loaded, cursor.epoch, cursor.seq)) {
      this.#replay(connection, cursor.seq);
      trySend(
        connection,
        JSON.stringify({
          type: EVENT_LOG_SYNCED,
          log: this.name,
          epoch: loaded.epoch,
          seq: loaded.head
        })
      );
    } else if (!this.#sendResync(connection, loaded)) {
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

  /** @internal Stop the flush timer; called when the host is destroyed. */
  dispose(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #canReplay(loaded: Loaded, epoch: string, seq: number): boolean {
    if (epoch !== loaded.epoch) return false;
    if (seq < 0 || seq > loaded.head) return false;
    const oldest = loaded.oldest ?? this.#buffer[0]?.seq ?? loaded.head + 1;
    if (seq < oldest - 1) return false;
    if (seq === 0 || seq < oldest) return true;
    // A cursor inside a gap saw events a crash lost.
    const row = this.#sql<{ kind: string; seq_to: number }>(
      `SELECT kind, seq_to FROM cf_agents_event_log_rows
       WHERE log = ? AND seq_from <= ? ORDER BY seq_from DESC LIMIT 1`,
      this.name,
      seq
    )[0];
    return !(row && row.kind === "gap" && row.seq_to >= seq);
  }

  #replay(connection: Connection, after: number): void {
    const prefix = `{"type":"${EVENT_LOG_EVENTS}","log":${JSON.stringify(this.name)},"events":`;
    const rows = this.#host.sql().exec<Row>(
      `SELECT seq_from, seq_to, kind, body, bytes FROM cf_agents_event_log_rows
         WHERE log = ? AND seq_to > ? ORDER BY seq_from ASC`,
      this.name,
      after
    );
    for (const row of rows) {
      if (row.kind !== "events") continue;
      if (row.seq_from > after) {
        trySend(connection, `${prefix}${row.body}}`);
        continue;
      }
      const entries = (JSON.parse(row.body) as { seq: number }[]).filter(
        (entry) => entry.seq > after
      );
      trySend(connection, `${prefix}${JSON.stringify(entries)}}`);
    }
    const buffered = this.#buffer.filter((entry) => entry.seq > after);
    if (buffered.length > 0) {
      trySend(
        connection,
        `${prefix}[${buffered.map((entry) => entry.json).join(",")}]}`
      );
    }
  }

  /** Send a resync with the host's snapshot. Returns false when it failed. */
  #sendResync(connection: Connection, loaded: Loaded): boolean {
    let snapshot: S | undefined;
    try {
      snapshot = this.#snapshot?.(connection);
    } catch (error) {
      console.error(`[EventLog] snapshot for "${this.name}" threw:`, error);
      this.#sendError(connection, "Snapshot failed");
      return false;
    }
    let text: string;
    try {
      text = JSON.stringify({
        type: EVENT_LOG_RESYNC,
        log: this.name,
        epoch: loaded.epoch,
        seq: loaded.head,
        ...(snapshot !== undefined && { snapshot })
      });
    } catch (error) {
      console.error(
        `[EventLog] snapshot for "${this.name}" is not JSON:`,
        error
      );
      this.#sendError(connection, "Snapshot failed");
      return false;
    }
    trySend(connection, text);
    return true;
  }

  #sendError(connection: Connection, error: string): void {
    trySend(
      connection,
      JSON.stringify({ type: EVENT_LOG_ERROR, log: this.name, error })
    );
  }

  #broadcast(entries: readonly Entry[]): void {
    const text = `{"type":"${EVENT_LOG_EVENTS}","log":${JSON.stringify(
      this.name
    )},"events":[${entries.map((entry) => entry.json).join(",")}]}`;
    for (const connection of this.#host.connections()) {
      if (followedLogs(connection).includes(this.name)) {
        trySend(connection, text);
      }
    }
  }

  // ── Storage ────────────────────────────────────────────────────────────

  #sql<R extends Record<string, SqlStorageValue>>(
    query: string,
    ...params: SqlStorageValue[]
  ): R[] {
    return this.#host
      .sql()
      .exec<R>(query, ...params)
      .toArray();
  }

  /** Serialize and number one event; throws before assigning a seq. */
  #entry(data: T): Entry {
    const loaded = this.#load();
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
    const seq = loaded.head + 1;
    loaded.head = seq;
    const json = `{"seq":${seq},"data":${dataJson}}`;
    return { seq, json, bytes: bytes + json.length - dataJson.length };
  }

  /**
   * Read the log once per isolate. When the newest row says a batch was
   * open, the previous isolate may have sent events it never stored:
   * record those seqs as a gap and resync the connections still
   * following (hibernated sockets survive an eviction).
   */
  #load(except?: Connection): Loaded {
    if (this.#loaded) return this.#loaded;
    const sql = this.#host.sql();
    ensureTables(sql);
    let epoch = this.#sql<{ epoch: string }>(
      `SELECT epoch FROM cf_agents_event_logs WHERE log = ?`,
      this.name
    )[0]?.epoch;
    if (epoch === undefined) {
      epoch = crypto.randomUUID();
      sql.exec(
        `INSERT INTO cf_agents_event_logs (log, epoch, created_at) VALUES (?, ?, ?)`,
        this.name,
        epoch,
        Date.now()
      );
    }
    const totals = this.#sql<{
      rows: number;
      oldest: number | null;
      events: number | null;
      bytes: number | null;
    }>(
      `SELECT COUNT(*) AS rows, MIN(seq_from) AS oldest,
         SUM(CASE kind WHEN 'events' THEN seq_to - seq_from + 1 ELSE 0 END) AS events,
         SUM(bytes) AS bytes
       FROM cf_agents_event_log_rows WHERE log = ?`,
      this.name
    )[0];
    const newest = this.#sql<{ seq_to: number; open_until: number | null }>(
      `SELECT seq_to, open_until FROM cf_agents_event_log_rows
       WHERE log = ? ORDER BY seq_from DESC LIMIT 1`,
      this.name
    )[0];
    const loaded: Loaded = {
      epoch,
      head: newest?.seq_to ?? 0,
      oldest: totals?.oldest ?? null,
      rows: totals?.rows ?? 0,
      events: totals?.events ?? 0,
      bytes: totals?.bytes ?? 0,
      newestOpen: false
    };
    this.#loaded = loaded;

    if (
      newest &&
      newest.open_until !== null &&
      newest.open_until > newest.seq_to
    ) {
      // A batch sends at most `maxEvents - 1` events it has not stored, so
      // the lost seqs end before `open_until`. Ending the gap at
      // `open_until` itself means no client cursor can equal the gap's
      // last seq, so once the gap is trimmed, a cursor just before the
      // oldest kept event is still one that never saw a lost event.
      const from = newest.seq_to + 1;
      const to = newest.open_until;
      sql.exec(
        `INSERT INTO cf_agents_event_log_rows
           (log, seq_from, seq_to, kind, body, bytes, open_until, created_at)
         VALUES (?, ?, ?, 'gap', '[]', 0, NULL, ?)`,
        this.name,
        from,
        to,
        Date.now()
      );
      loaded.head = to;
      loaded.rows += 1;
      this.#host.emit("eventlog:gap", { log: this.name, from, to });
      this.#trim(loaded);
      for (const connection of this.#host.connections()) {
        if (connection === except) continue;
        if (!followedLogs(connection).includes(this.name)) continue;
        if (!this.#sendResync(connection, loaded)) this.unsubscribe(connection);
      }
    }
    return loaded;
  }

  /**
   * Write the buffer as rows of whole events, each under the row limit,
   * then trim to retention. With nothing buffered, only clears the open
   * mark once the last batch has closed.
   */
  #flush(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const loaded = this.#load();
    const open = this.#openBatches > 0;
    if (this.#buffer.length === 0) {
      if (loaded.newestOpen && !open) {
        this.#host.sql().exec(
          `UPDATE cf_agents_event_log_rows SET open_until = NULL
             WHERE log = ? AND seq_from = (SELECT MAX(seq_from) FROM cf_agents_event_log_rows WHERE log = ?)`,
          this.name,
          this.name
        );
        loaded.newestOpen = false;
      }
      return;
    }
    const buffer = this.#buffer;
    this.#buffer = [];
    this.#bufferBytes = 0;
    const sql = this.#host.sql();
    const now = Date.now();
    let start = 0;
    while (start < buffer.length) {
      let end = start + 1;
      let bytes = buffer[start].bytes;
      while (
        end < buffer.length &&
        bytes + buffer[end].bytes + 1 <= ROW_MAX_BYTES
      ) {
        bytes += buffer[end].bytes + 1;
        end += 1;
      }
      const rowEntries = buffer.slice(start, end);
      const seqFrom = rowEntries[0].seq;
      const seqTo = rowEntries[rowEntries.length - 1].seq;
      const body = `[${rowEntries.map((entry) => entry.json).join(",")}]`;
      sql.exec(
        `INSERT INTO cf_agents_event_log_rows
           (log, seq_from, seq_to, kind, body, bytes, open_until, created_at)
         VALUES (?, ?, ?, 'events', ?, ?, ?, ?)`,
        this.name,
        seqFrom,
        seqTo,
        body,
        bytes + 2,
        open ? seqTo + this.#batchEvents : null,
        now
      );
      loaded.rows += 1;
      loaded.events += rowEntries.length;
      loaded.bytes += bytes + 2;
      loaded.oldest ??= seqFrom;
      start = end;
    }
    loaded.newestOpen = open;
    this.#trim(loaded);
  }

  /** Delete the oldest rows while over retention, never the newest one. */
  #trim(loaded: Loaded): void {
    while (
      loaded.rows > 1 &&
      (loaded.events > this.#retentionEvents ||
        loaded.bytes > this.#retentionBytes)
    ) {
      const oldest = this.#sql<{
        seq_from: number;
        seq_to: number;
        kind: string;
        bytes: number;
      }>(
        `SELECT seq_from, seq_to, kind, bytes FROM cf_agents_event_log_rows
         WHERE log = ? ORDER BY seq_from ASC LIMIT 1`,
        this.name
      )[0];
      if (!oldest) break;
      this.#host
        .sql()
        .exec(
          `DELETE FROM cf_agents_event_log_rows WHERE log = ? AND seq_from = ?`,
          this.name,
          oldest.seq_from
        );
      loaded.rows -= 1;
      if (oldest.kind === "events") {
        loaded.events -= oldest.seq_to - oldest.seq_from + 1;
      }
      loaded.bytes -= oldest.bytes;
      // Rows cover contiguous seq ranges, so the next row starts here.
      loaded.oldest = oldest.seq_to + 1;
    }
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
