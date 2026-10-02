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

/** pi's asynchronous SQLite facade over a Durable Object's synchronous SQL API. */
class DurableObjectSqliteExecutor implements SqliteExecutor {
  readonly #sql: SqlStorage;
  readonly #prefixer: Prefixer;
  readonly #assertActive: () => void;

  constructor(
    sql: SqlStorage,
    prefixer: Prefixer,
    assertActive: () => void = () => {}
  ) {
    this.#sql = sql;
    this.#prefixer = prefixer;
    this.#assertActive = assertActive;
  }

  async exec(sql: string): Promise<void> {
    this.#assertActive();
    this.#sql.exec(this.#prefixer.rewrite(sql));
  }

  async run(sql: string, ...params: SqliteValue[]): Promise<void> {
    this.#assertActive();
    this.#sql.exec(this.#prefixer.rewrite(sql), ...params.map(binding));
  }

  async get<T extends object>(
    sql: string,
    ...params: SqliteValue[]
  ): Promise<T | undefined> {
    this.#assertActive();
    const cursor = this.#sql.exec(
      this.#prefixer.rewrite(sql),
      ...params.map(binding)
    );
    const first = cursor.next();
    return first.done ? undefined : row<T>(first.value);
  }

  async all<T extends object>(
    sql: string,
    ...params: SqliteValue[]
  ): Promise<T[]> {
    this.#assertActive();
    return this.#sql
      .exec(this.#prefixer.rewrite(sql), ...params.map(binding))
      .toArray()
      .map((raw) => row<T>(raw));
  }
}

/**
 * pi's `SqliteDatabase` facade over `DurableObjectStorage`.
 *
 * Durable Objects expose async `storage.transaction()` for SQLite-backed
 * objects, which includes SQL operations made through `storage.sql` in the
 * callback. SQL itself remains synchronous, so each adapter operation consumes
 * its cursor before returning its promise.
 */
export class DurableObjectSqliteDatabase
  extends DurableObjectSqliteExecutor
  implements SqliteDatabase
{
  readonly #storage: DurableObjectStorage;
  readonly #prefixer: Prefixer;

  constructor(
    storage: DurableObjectStorage,
    options: PiSessionStoreOptions = {}
  ) {
    const prefixer = new Prefixer(options.prefix ?? DEFAULT_PREFIX);
    super(storage.sql, prefixer);
    this.#storage = storage;
    this.#prefixer = prefixer;
  }

  transaction<T>(
    callback: (transaction: SqliteExecutor) => Promise<T>
  ): Promise<T> {
    return this.#storage.transaction(async () => {
      let active = true;
      const transaction = new DurableObjectSqliteExecutor(
        this.#storage.sql,
        this.#prefixer,
        () => {
          if (!active) {
            throw new Error("The pi SQLite transaction is no longer active");
          }
        }
      );
      try {
        return await callback(transaction);
      } finally {
        active = false;
      }
    });
  }

  /** The object owns the database; there is nothing to close. */
  close(): Promise<void> {
    return Promise.resolve();
  }
}
