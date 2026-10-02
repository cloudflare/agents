import {
  SQLITE_MIGRATIONS,
  SqliteStorage,
  type SqliteDatabase,
  type SqliteExecutor,
  type SqliteValue
} from "@earendil-works/pi-durable/storage/sqlite";

/**
 * pi's session store on a Durable Object's SQLite database.
 *
 * pi owns its sessions: conversations, entries, tasks, submissions, and
 * documents live in pi's own schema, created and migrated by pi's portable
 * `SqliteStorage`. This file only supplies the asynchronous database facade
 * pi asks for, over `ctx.storage.sql`, and moves pi's tables under a prefix
 * so they cannot collide with the SDK's or the host's tables in the same
 * object.
 *
 * It is the Durable Object counterpart of `agents/sessions` for a harness
 * that brings its own session model, and has nothing pi-harness specific in
 * it: any harness built on pi-durable can open its storage with it.
 */
export type PiSessionStoreOptions = {
  /**
   * Prefix for every table and index pi creates. Must not start with `_cf_`,
   * which Durable Objects reserve. Default `pi_`.
   */
  readonly prefix?: string;
};

const DEFAULT_PREFIX = "pi_";

/** Open pi-durable's storage over this object's SQLite database. */
export function openPiSessionStore(
  storage: DurableObjectStorage,
  options: PiSessionStoreOptions = {}
): Promise<SqliteStorage> {
  return SqliteStorage.open(new DurableObjectSqliteDatabase(storage, options));
}

/** Names pi's migrations create: every table and index, in any version. */
function schemaNames(): readonly string[] {
  const names = new Set<string>(["durable_schema"]);
  const pattern =
    /\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const migration of SQLITE_MIGRATIONS) {
    for (const statement of migration.statements) {
      for (const match of statement.matchAll(pattern)) names.add(match[1]);
    }
  }
  return [...names];
}

/**
 * Rewrites pi's schema identifiers outside string literals. Identifiers are
 * matched on word boundaries, so column names such as `record_type` or
 * `document_id` are left alone.
 */
class Prefixer {
  readonly #pattern: RegExp;
  readonly #prefix: string;
  readonly #cache = new Map<string, string>();

  constructor(prefix: string) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(prefix)) {
      throw new Error(
        `Invalid pi session store prefix ${JSON.stringify(prefix)}`
      );
    }
    if (prefix.startsWith("_cf_")) {
      throw new Error("The pi session store prefix must not start with _cf_");
    }
    this.#prefix = prefix;
    this.#pattern = new RegExp(`\\b(${schemaNames().join("|")})\\b`, "g");
  }

  rewrite(sql: string): string {
    const cached = this.#cache.get(sql);
    if (cached !== undefined) return cached;
    // Split on single-quoted literals ('' escapes stay inside a literal).
    const rewritten = sql
      .split(/('(?:[^']|'')*')/)
      .map((part, index) =>
        index % 2 === 1
          ? part
          : part.replace(this.#pattern, (name) => `${this.#prefix}${name}`)
      )
      .join("");
    this.#cache.set(sql, rewritten);
    return rewritten;
  }
}

/** Durable Objects bind strings, numbers, null, and ArrayBuffers. */
function binding(value: SqliteValue): SqlStorageValue {
  if (typeof value === "bigint") {
    if (
      value > BigInt(Number.MAX_SAFE_INTEGER) ||
      value < BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      throw new RangeError(`SQLite integer ${value} is outside the safe range`);
    }
    return Number(value);
  }
  if (value instanceof Uint8Array) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength
    ) as ArrayBuffer;
  }
  return value;
}

/** Blobs come back as ArrayBuffers; pi's contract reads Uint8Arrays. */
function row<T extends object>(raw: Record<string, SqlStorageValue>): T {
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (value instanceof ArrayBuffer) {
      (raw as Record<string, unknown>)[key] = new Uint8Array(value);
    }
  }
  return raw as T;
}

/**
 * Orders calls on the one SQLite connection. A statement runs at once,
 * directly, when nothing is waiting; while a transaction is open, it and
 * every call after it wait, in call order, for the transaction to settle,
 * so none runs inside it. A failure does not stop the calls behind it.
 *
 * The queue holds calls, not data: a caller has no result until its call
 * runs, so an isolate that dies loses only calls nobody has seen succeed,
 * as it would without the queue. pi's transactions await only their own
 * synchronous statements, so a transaction holds the queue for microtasks,
 * never for I/O.
 */
class OperationQueue {
  #tail: Promise<void> = Promise.resolve();
  /** Calls queued or holding the queue, not yet settled. */
  #pending = 0;

  /** A synchronous statement: runs now unless something is ahead of it. */
  run<T>(statement: () => T): Promise<T> {
    if (this.#pending > 0) return this.#enqueue(statement);
    try {
      return Promise.resolve(statement());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** An asynchronous call that holds the queue until it settles. */
  hold<T>(call: () => Promise<T>): Promise<T> {
    return this.#enqueue(call);
  }

  #enqueue<T>(call: () => T | Promise<T>): Promise<T> {
    this.#pending += 1;
    const settled = this.#tail.then(call).finally(() => {
      this.#pending -= 1;
    });
    this.#tail = settled.then(
      () => undefined,
      () => undefined
    );
    return settled;
  }
}

/** One statement on a Durable Object's synchronous SQL API. */
class Statements {
  readonly #sql: SqlStorage;
  readonly #prefixer: Prefixer;

  constructor(sql: SqlStorage, prefixer: Prefixer) {
    this.#sql = sql;
    this.#prefixer = prefixer;
  }

  exec(sql: string): void {
    this.#sql.exec(this.#prefixer.rewrite(sql));
  }

  run(sql: string, params: readonly SqliteValue[]): void {
    this.#sql.exec(this.#prefixer.rewrite(sql), ...params.map(binding));
  }

  get<T extends object>(
    sql: string,
    params: readonly SqliteValue[]
  ): T | undefined {
    const first = this.#sql
      .exec(this.#prefixer.rewrite(sql), ...params.map(binding))
      .next();
    return first.done ? undefined : row<T>(first.value);
  }

  all<T extends object>(sql: string, params: readonly SqliteValue[]): T[] {
    return this.#sql
      .exec(this.#prefixer.rewrite(sql), ...params.map(binding))
      .toArray()
      .map((raw) => row<T>(raw));
  }
}

/**
 * The handle pi's transaction callback gets. It runs statements directly:
 * the transaction holds the database's queue for as long as it is open.
 */
class DurableObjectSqliteTransaction implements SqliteExecutor {
  readonly #statements: Statements;
  #active = true;

  constructor(statements: Statements) {
    this.#statements = statements;
  }

  /** Called once the transaction settles; the handle is unusable after. */
  end(): void {
    this.#active = false;
  }

  async exec(sql: string): Promise<void> {
    this.#assertActive();
    this.#statements.exec(sql);
  }

  async run(sql: string, ...params: SqliteValue[]): Promise<void> {
    this.#assertActive();
    this.#statements.run(sql, params);
  }

  async get<T extends object>(
    sql: string,
    ...params: SqliteValue[]
  ): Promise<T | undefined> {
    this.#assertActive();
    return this.#statements.get<T>(sql, params);
  }

  async all<T extends object>(
    sql: string,
    ...params: SqliteValue[]
  ): Promise<T[]> {
    this.#assertActive();
    return this.#statements.all<T>(sql, params);
  }

  #assertActive(): void {
    if (!this.#active) {
      throw new Error("The pi SQLite transaction is no longer active");
    }
  }
}

/**
 * pi's `SqliteDatabase` facade over `DurableObjectStorage`.
 *
 * Durable Object SQL is synchronous, but pi's facade is asynchronous and a
 * transaction's callback awaits between statements. A statement issued
 * outside the transaction while it waits would run inside it: it would see
 * uncommitted rows, and roll back with it. pi's contract therefore has the
 * adapter queue every other call until the transaction settles: every
 * call goes through one `OperationQueue`, which runs a statement at once
 * when no transaction is open. As the contract says, a call on the database from inside a
 * transaction's callback waits for that transaction and never settles; the
 * callback must use its handle.
 *
 * Transactions run in `storage.transaction()`, which rolls back when the
 * callback rejects and rejects with the same error.
 */
export class DurableObjectSqliteDatabase implements SqliteDatabase {
  readonly #storage: DurableObjectStorage;
  readonly #statements: Statements;
  readonly #queue = new OperationQueue();

  constructor(
    storage: DurableObjectStorage,
    options: PiSessionStoreOptions = {}
  ) {
    this.#storage = storage;
    this.#statements = new Statements(
      storage.sql,
      new Prefixer(options.prefix ?? DEFAULT_PREFIX)
    );
  }

  exec(sql: string): Promise<void> {
    return this.#queue.run(() => this.#statements.exec(sql));
  }

  run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.#queue.run(() => this.#statements.run(sql, params));
  }

  get<T extends object>(
    sql: string,
    ...params: SqliteValue[]
  ): Promise<T | undefined> {
    return this.#queue.run(() => this.#statements.get<T>(sql, params));
  }

  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.#queue.run(() => this.#statements.all<T>(sql, params));
  }

  transaction<T>(
    callback: (transaction: SqliteExecutor) => Promise<T>
  ): Promise<T> {
    return this.#queue.hold(() =>
      this.#storage.transaction(async () => {
        const transaction = new DurableObjectSqliteTransaction(
          this.#statements
        );
        try {
          return await callback(transaction);
        } finally {
          transaction.end();
        }
      })
    );
  }

  /** The object owns the database; there is nothing to close. */
  close(): Promise<void> {
    return this.#queue.run(() => undefined);
  }
}
