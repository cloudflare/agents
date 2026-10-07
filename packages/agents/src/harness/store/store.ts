/**
 * A session store for harnesses, on a Durable Object's SQLite database.
 *
 * Any harness that runs its agent somewhere other than the object (a
 * container, a sandbox, a remote process) needs the same few things kept
 * durably next to it: which sessions exist, which operations were submitted
 * and how each one ended, and the session's history in whatever format the
 * harness speaks. This store keeps those and nothing more. It knows no
 * message format, no event vocabulary and no runtime: inputs, results,
 * session state and log entries are opaque JSON that the harness parses.
 *
 * Three record kinds:
 *
 * - **Sessions**: an id, an optional parent (a fork), and one JSON state
 *   value the harness owns (model, cursors, resume handles).
 * - **Operations**: one row per submitted operation, keyed by an
 *   idempotency id within its session, moving `queued` → `running` →
 *   `done` | `unanswered`. Transitions are guarded in SQL, so a duplicate or
 *   late transition is a no-op rather than a regression.
 * - **Logs**: named, append-ordered streams of JSON entries per session
 *   (`"messages"`, `"engine"`, …). An entry may carry an id, and an entry
 *   written again under the same id replaces the old one in place. Entries
 *   larger than one SQLite row are split across continuation rows.
 *
 * The store is synchronous, like the SQL API under it, so a harness can
 * group several writes in `transaction()` without awaiting.
 *
 * @experimental The API may change before it stabilizes.
 */

/** A JSON value, as the store keeps it. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Where an operation is in its life. */
export type OperationStatus = "queued" | "running" | "done" | "unanswered";

/** A session, as stored. */
export type SessionRecord = {
  readonly id: string;
  /** The session this one was forked from. */
  readonly parent: string | undefined;
  /** Harness-owned state. `null` until the harness writes some. */
  readonly state: JsonValue;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/** One operation, as stored. */
export type OperationRecord = {
  readonly session: string;
  /** The idempotency key, unique within the session. */
  readonly id: string;
  /** Submission order within the whole store. */
  readonly seq: number;
  readonly status: OperationStatus;
  /** What was submitted, in the harness's format. */
  readonly input: JsonValue;
  /** Harness-owned submission options and bookkeeping. */
  readonly meta: JsonValue;
  /** The harness's result for a `done` operation, else `null`. */
  readonly result: JsonValue;
  /** Why an `unanswered` operation ended. */
  readonly reason: string | undefined;
  readonly createdAt: number;
  readonly settledAt: number | undefined;
};

/** One log entry, as stored. */
export type LogEntry = {
  /** Position in the log. Stable when the entry is replaced by id. */
  readonly seq: number;
  readonly id: string | undefined;
  readonly data: JsonValue;
  readonly createdAt: number;
};

/** One entry to append. */
export type LogAppend = {
  /** Replace an existing entry with this id in place, instead of appending. */
  readonly id?: string;
  readonly data: JsonValue;
};

/** How an operation ended. */
export type OperationOutcome =
  | { readonly status: "done"; readonly result: JsonValue }
  | { readonly status: "unanswered"; readonly reason: string };

/** `openHarnessStore`'s options. */
export type HarnessStoreOptions = {
  /**
   * Prefix for the store's tables. Two harnesses in one object use two
   * prefixes. Must not start with `_cf_`, which Durable Objects reserve.
   * Default `harness_`.
   */
  readonly prefix?: string;
};

const DEFAULT_PREFIX = "harness_";

/**
 * Characters per stored chunk of a JSON value. A Durable Object row holds
 * at most 2 MB and a character is at most 4 bytes of UTF-8, so a quarter of
 * a megabyte of characters always fits with room for the other columns.
 */
const CHUNK_CHARS = 256 * 1024;

/**
 * Open the store over this object's SQLite database, creating its tables on
 * first use. Cheap: call it once per isolate and keep the result.
 *
 * @param storage - The Durable Object's storage.
 * @param options - Table prefix.
 * @returns The store.
 */
export function openHarnessStore(
  storage: DurableObjectStorage,
  options: HarnessStoreOptions = {}
): HarnessStore {
  return new HarnessStore(storage, options);
}

type SessionRow = {
  id: string;
  parent: string | null;
  state: string;
  created_at: number;
  updated_at: number;
};

type OperationRow = {
  session: string;
  id: string;
  seq: number;
  status: string;
  input: string;
  meta: string;
  result: string;
  reason: string | null;
  created_at: number;
  settled_at: number | null;
};

type LogRow = {
  seq: number;
  part: number;
  id: string | null;
  data: string;
  created_at: number;
};

function parseJson(text: string): JsonValue {
  // SAFETY: every stored value was produced by JSON.stringify of a JsonValue
  // in this module; parsing it back yields the same shape.
  return JSON.parse(text) as JsonValue;
}

function isStatus(value: string): value is OperationStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "done" ||
    value === "unanswered"
  );
}

function chunks(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  const parts: string[] = [];
  for (let at = 0; at < text.length; at += CHUNK_CHARS) {
    parts.push(text.slice(at, at + CHUNK_CHARS));
  }
  return parts;
}

/**
 * The store. Construct it with `openHarnessStore`.
 *
 * @experimental The API may change before it stabilizes.
 */
export class HarnessStore {
  readonly #storage: DurableObjectStorage;
  readonly #sessions: string;
  readonly #operations: string;
  readonly #log: string;

  /**
   * @param storage - The Durable Object's storage.
   * @param options - Table prefix.
   */
  constructor(storage: DurableObjectStorage, options: HarnessStoreOptions) {
    const prefix = options.prefix ?? DEFAULT_PREFIX;
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(prefix)) {
      throw new Error(`Invalid harness store prefix ${JSON.stringify(prefix)}`);
    }
    if (prefix.startsWith("_cf_")) {
      throw new Error("The harness store prefix must not start with _cf_");
    }
    this.#storage = storage;
    this.#sessions = `${prefix}sessions`;
    this.#operations = `${prefix}operations`;
    this.#log = `${prefix}log`;
    this.#migrate();
  }

  #migrate(): void {
    const sql = this.#storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS ${this.#sessions} (
      id TEXT PRIMARY KEY,
      parent TEXT,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS ${this.#operations} (
      session TEXT NOT NULL,
      id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      status TEXT NOT NULL,
      input TEXT NOT NULL,
      meta TEXT NOT NULL,
      result TEXT NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL,
      settled_at INTEGER,
      PRIMARY KEY (session, id)
    )`);
    sql.exec(
      `CREATE INDEX IF NOT EXISTS ${this.#operations}_open ON ${this.#operations} (status, seq)`
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS ${this.#log} (
      session TEXT NOT NULL,
      log TEXT NOT NULL,
      seq INTEGER NOT NULL,
      part INTEGER NOT NULL,
      id TEXT,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session, log, seq, part)
    )`);
    sql.exec(
      `CREATE INDEX IF NOT EXISTS ${this.#log}_id ON ${this.#log} (session, log, id) WHERE id IS NOT NULL`
    );
  }

  /**
   * Run `fn` in one storage transaction. Writes inside it commit together or
   * not at all.
   *
   * @template T - What `fn` returns.
   * @param fn - Synchronous work against this store.
   * @returns What `fn` returned.
   */
  transaction<T>(fn: () => T): T {
    return this.#storage.transactionSync(fn);
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  /**
   * Create a session, or return the existing one with this id unchanged.
   *
   * @param input - The id, an optional parent, and the initial state.
   * @returns The stored session.
   */
  createSession(input: {
    readonly id: string;
    readonly parent?: string;
    readonly state?: JsonValue;
  }): SessionRecord {
    const now = Date.now();
    this.#storage.sql.exec(
      `INSERT INTO ${this.#sessions} (id, parent, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      input.id,
      input.parent ?? null,
      JSON.stringify(input.state ?? null),
      now,
      now
    );
    const created = this.session(input.id);
    if (!created) throw new Error(`Session ${input.id} was not stored`);
    return created;
  }

  /**
   * Read one session.
   *
   * @param id - The session id.
   * @returns The session, or `undefined` when there is none.
   */
  session(id: string): SessionRecord | undefined {
    const row = this.#storage.sql
      .exec<SessionRow>(`SELECT * FROM ${this.#sessions} WHERE id = ?`, id)
      .toArray()[0];
    return row ? this.#sessionOf(row) : undefined;
  }

  /**
   * Every session, oldest first.
   *
   * @returns The sessions.
   */
  sessions(): SessionRecord[] {
    return this.#storage.sql
      .exec<SessionRow>(
        `SELECT * FROM ${this.#sessions} ORDER BY created_at, id`
      )
      .toArray()
      .map((row) => this.#sessionOf(row));
  }

  /**
   * Replace a session's harness-owned state.
   *
   * @param id - The session id.
   * @param state - The new state.
   * @returns False when there is no such session.
   */
  setSessionState(id: string, state: JsonValue): boolean {
    return (
      this.#storage.sql.exec(
        `UPDATE ${this.#sessions} SET state = ?, updated_at = ? WHERE id = ?`,
        JSON.stringify(state),
        Date.now(),
        id
      ).rowsWritten > 0
    );
  }

  /**
   * Delete a session with its operations and logs.
   *
   * @param id - The session id.
   * @returns False when there was no such session.
   */
  deleteSession(id: string): boolean {
    return this.transaction(() => {
      const sql = this.#storage.sql;
      sql.exec(`DELETE FROM ${this.#operations} WHERE session = ?`, id);
      sql.exec(`DELETE FROM ${this.#log} WHERE session = ?`, id);
      return (
        sql.exec(`DELETE FROM ${this.#sessions} WHERE id = ?`, id).rowsWritten >
        0
      );
    });
  }

  #sessionOf(row: SessionRow): SessionRecord {
    return {
      id: row.id,
      parent: row.parent ?? undefined,
      state: parseJson(row.state),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  // ── Operations ───────────────────────────────────────────────────────────

  /**
   * Durably queue an operation. Idempotent on `(session, id)`: a second
   * enqueue with the same id stores nothing and returns the first record.
   *
   * @param input - The session, the idempotency id, the input and options.
   * @returns The stored record, and whether this call created it.
   */
  enqueue(input: {
    readonly session: string;
    readonly id: string;
    readonly input: JsonValue;
    readonly meta?: JsonValue;
  }): { readonly record: OperationRecord; readonly accepted: boolean } {
    return this.transaction(() => {
      const existing = this.operation(input.session, input.id);
      if (existing) return { record: existing, accepted: false };
      const sql = this.#storage.sql;
      const next =
        sql
          .exec<{
            seq: number | null;
          }>(`SELECT MAX(seq) AS seq FROM ${this.#operations}`)
          .toArray()[0]?.seq ?? 0;
      sql.exec(
        `INSERT INTO ${this.#operations}
           (session, id, seq, status, input, meta, result, reason, created_at, settled_at)
         VALUES (?, ?, ?, 'queued', ?, ?, 'null', NULL, ?, NULL)`,
        input.session,
        input.id,
        next + 1,
        JSON.stringify(input.input),
        JSON.stringify(input.meta ?? null),
        Date.now()
      );
      const record = this.operation(input.session, input.id);
      if (!record) throw new Error(`Operation ${input.id} was not stored`);
      return { record, accepted: true };
    });
  }

  /**
   * Read one operation.
   *
   * @param session - The session id.
   * @param id - The operation id.
   * @returns The operation, or `undefined` when there is none.
   */
  operation(session: string, id: string): OperationRecord | undefined {
    const row = this.#storage.sql
      .exec<OperationRow>(
        `SELECT * FROM ${this.#operations} WHERE session = ? AND id = ?`,
        session,
        id
      )
      .toArray()[0];
    return row ? this.#operationOf(row) : undefined;
  }

  /**
   * Operations in submission order, optionally narrowed to one session and
   * to some statuses.
   *
   * @param filter - The session and statuses to keep. Default: all.
   * @returns The matching operations, oldest first.
   */
  operations(
    filter: {
      readonly session?: string;
      readonly status?: readonly OperationStatus[];
    } = {}
  ): OperationRecord[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.session !== undefined) {
      where.push("session = ?");
      params.push(filter.session);
    }
    if (filter.status !== undefined) {
      if (filter.status.length === 0) return [];
      where.push(`status IN (${filter.status.map(() => "?").join(", ")})`);
      params.push(...filter.status);
    }
    return this.#storage.sql
      .exec<OperationRow>(
        `SELECT * FROM ${this.#operations}
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY seq`,
        ...params
      )
      .toArray()
      .map((row) => this.#operationOf(row));
  }

  /**
   * Move a queued operation to `running`.
   *
   * @param session - The session id.
   * @param id - The operation id.
   * @returns False when it was not queued.
   */
  start(session: string, id: string): boolean {
    return this.#transition(session, id, ["queued"], "running");
  }

  /**
   * Move a running operation back to `queued`, to run it again.
   *
   * @param session - The session id.
   * @param id - The operation id.
   * @returns False when it was not running.
   */
  requeue(session: string, id: string): boolean {
    return this.#transition(session, id, ["running"], "queued");
  }

  /**
   * Settle a queued or running operation.
   *
   * @param session - The session id.
   * @param id - The operation id.
   * @param outcome - How it ended.
   * @returns False when it had already settled or does not exist.
   */
  settle(session: string, id: string, outcome: OperationOutcome): boolean {
    return (
      this.#storage.sql.exec(
        `UPDATE ${this.#operations}
         SET status = ?, result = ?, reason = ?, settled_at = ?
         WHERE session = ? AND id = ? AND status IN ('queued', 'running')`,
        outcome.status,
        JSON.stringify(outcome.status === "done" ? outcome.result : null),
        outcome.status === "unanswered" ? outcome.reason : null,
        Date.now(),
        session,
        id
      ).rowsWritten > 0
    );
  }

  /**
   * Replace an operation's harness-owned bookkeeping.
   *
   * @param session - The session id.
   * @param id - The operation id.
   * @param meta - The new value.
   * @returns False when there is no such operation.
   */
  setOperationMeta(session: string, id: string, meta: JsonValue): boolean {
    return (
      this.#storage.sql.exec(
        `UPDATE ${this.#operations} SET meta = ? WHERE session = ? AND id = ?`,
        JSON.stringify(meta),
        session,
        id
      ).rowsWritten > 0
    );
  }

  #transition(
    session: string,
    id: string,
    from: readonly OperationStatus[],
    to: OperationStatus
  ): boolean {
    return (
      this.#storage.sql.exec(
        `UPDATE ${this.#operations} SET status = ?
         WHERE session = ? AND id = ? AND status IN (${from.map(() => "?").join(", ")})`,
        to,
        session,
        id,
        ...from
      ).rowsWritten > 0
    );
  }

  #operationOf(row: OperationRow): OperationRecord {
    if (!isStatus(row.status)) {
      throw new Error(`Unknown operation status ${row.status}`);
    }
    return {
      session: row.session,
      id: row.id,
      seq: row.seq,
      status: row.status,
      input: parseJson(row.input),
      meta: parseJson(row.meta),
      result: parseJson(row.result),
      reason: row.reason ?? undefined,
      createdAt: row.created_at,
      settledAt: row.settled_at ?? undefined
    };
  }

  // ── Logs ─────────────────────────────────────────────────────────────────

  /**
   * Append entries to a session's log. An entry with an id that is already
   * in the log replaces that entry in place, keeping its position.
   *
   * @param session - The session id.
   * @param log - The log's name, such as `"messages"`.
   * @param entries - The entries, in order.
   * @returns The position of the last entry written, or of the log's end.
   */
  append(session: string, log: string, entries: readonly LogAppend[]): number {
    return this.transaction(() => {
      let end = this.end(session, log);
      for (const entry of entries) {
        const existing =
          entry.id === undefined
            ? undefined
            : this.#seqOf(session, log, entry.id);
        if (existing !== undefined) {
          this.#write(session, log, existing, entry);
          continue;
        }
        end += 1;
        this.#write(session, log, end, entry);
      }
      return end;
    });
  }

  /**
   * Read a session's log in order.
   *
   * @param session - The session id.
   * @param log - The log's name.
   * @param range - Entries after position `after` (exclusive), at most `limit`.
   * @returns The entries.
   */
  read(
    session: string,
    log: string,
    range: { readonly after?: number; readonly limit?: number } = {}
  ): LogEntry[] {
    const after = range.after ?? 0;
    const limit = range.limit ?? -1;
    const rows = this.#storage.sql
      .exec<LogRow>(
        `SELECT seq, part, id, data, created_at FROM ${this.#log}
         WHERE session = ? AND log = ? AND seq IN (
           SELECT DISTINCT seq FROM ${this.#log}
           WHERE session = ? AND log = ? AND seq > ?
           ORDER BY seq LIMIT ?
         )
         ORDER BY seq, part`,
        session,
        log,
        session,
        log,
        after,
        limit
      )
      .toArray();
    const entries: LogEntry[] = [];
    let current: { row: LogRow; text: string } | undefined;
    const flush = () => {
      if (!current) return;
      entries.push({
        seq: current.row.seq,
        id: current.row.id ?? undefined,
        data: parseJson(current.text),
        createdAt: current.row.created_at
      });
    };
    for (const row of rows) {
      if (current && current.row.seq === row.seq) {
        current.text += row.data;
        continue;
      }
      flush();
      current = { row, text: row.data };
    }
    flush();
    return entries;
  }

  /**
   * One entry by id.
   *
   * @param session - The session id.
   * @param log - The log's name.
   * @param id - The entry id.
   * @returns The entry, or `undefined`.
   */
  entry(session: string, log: string, id: string): LogEntry | undefined {
    const seq = this.#seqOf(session, log, id);
    if (seq === undefined) return undefined;
    return this.read(session, log, { after: seq - 1, limit: 1 })[0];
  }

  /**
   * The position of a log's last entry.
   *
   * @param session - The session id.
   * @param log - The log's name.
   * @returns The position, or 0 for an empty log.
   */
  end(session: string, log: string): number {
    return (
      this.#storage.sql
        .exec<{ seq: number | null }>(
          `SELECT MAX(seq) AS seq FROM ${this.#log} WHERE session = ? AND log = ?`,
          session,
          log
        )
        .toArray()[0]?.seq ?? 0
    );
  }

  /**
   * Empty a session's log.
   *
   * @param session - The session id.
   * @param log - The log's name.
   */
  clear(session: string, log: string): void {
    this.#storage.sql.exec(
      `DELETE FROM ${this.#log} WHERE session = ? AND log = ?`,
      session,
      log
    );
  }

  /**
   * Copy one session's log onto the end of another's, keeping entry ids.
   *
   * @param from - The source session.
   * @param to - The target session.
   * @param log - The log's name.
   */
  copy(from: string, to: string, log: string): void {
    this.transaction(() => {
      const offset = this.end(to, log);
      this.#storage.sql.exec(
        `INSERT INTO ${this.#log} (session, log, seq, part, id, data, created_at)
         SELECT ?, log, seq + ?, part, id, data, created_at FROM ${this.#log}
         WHERE session = ? AND log = ?`,
        to,
        offset,
        from,
        log
      );
    });
  }

  #seqOf(session: string, log: string, id: string): number | undefined {
    return this.#storage.sql
      .exec<{ seq: number }>(
        `SELECT seq FROM ${this.#log} WHERE session = ? AND log = ? AND id = ? LIMIT 1`,
        session,
        log,
        id
      )
      .toArray()[0]?.seq;
  }

  #write(session: string, log: string, seq: number, entry: LogAppend): void {
    const sql = this.#storage.sql;
    const createdAt =
      sql
        .exec<{ created_at: number }>(
          `SELECT created_at FROM ${this.#log} WHERE session = ? AND log = ? AND seq = ? LIMIT 1`,
          session,
          log,
          seq
        )
        .toArray()[0]?.created_at ?? Date.now();
    sql.exec(
      `DELETE FROM ${this.#log} WHERE session = ? AND log = ? AND seq = ?`,
      session,
      log,
      seq
    );
    chunks(JSON.stringify(entry.data)).forEach((part, index) => {
      sql.exec(
        `INSERT INTO ${this.#log} (session, log, seq, part, id, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        session,
        log,
        seq,
        index,
        entry.id ?? null,
        part,
        createdAt
      );
    });
  }
}
