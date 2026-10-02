import {
  SQLITE_MIGRATIONS,
  SqliteStorage,
  type SqliteDatabase,
  type SqliteStatement,
  type SqliteValue
} from "@earendil-works/pi-durable/storage/sqlite";

/**
 * pi's session store on a Durable Object's SQLite database.
 *
 * pi owns its sessions: conversations, entries, tasks, submissions, and
 * documents live in pi's own schema, created and migrated by pi's portable
 * `SqliteStorage`. This file only supplies the synchronous database facade
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

class DurableObjectSqliteStatement implements SqliteStatement {
  readonly #sql: SqlStorage;
  readonly #query: string;

  constructor(sql: SqlStorage, query: string) {
    this.#sql = sql;
    this.#query = query;
  }

  run(...params: SqliteValue[]): void {
    this.#sql.exec(this.#query, ...params.map(binding));
  }

  get<T extends object>(...params: SqliteValue[]): T | undefined {
    const cursor = this.#sql.exec(this.#query, ...params.map(binding));
    const first = cursor.next();
    return first.done ? undefined : row<T>(first.value);
  }

  all<T extends object>(...params: SqliteValue[]): T[] {
    return this.#sql
      .exec(this.#query, ...params.map(binding))
      .toArray()
      .map((raw) => row<T>(raw));
  }
}

/**
 * pi's `SqliteDatabase` facade over `DurableObjectStorage`.
 *
 * Durable Objects reject `BEGIN`, so transactions go through
 * `transactionSync`, which rolls back when the callback throws and rethrows
 * the same error, as pi's contract requires. Durable Objects have no
 * prepared statements either; a statement is the query text, executed on
 * each call.
 */
export class DurableObjectSqliteDatabase implements SqliteDatabase {
  readonly #storage: DurableObjectStorage;
  readonly #prefixer: Prefixer;

  constructor(
    storage: DurableObjectStorage,
    options: PiSessionStoreOptions = {}
  ) {
    this.#storage = storage;
    this.#prefixer = new Prefixer(options.prefix ?? DEFAULT_PREFIX);
  }

  exec(sql: string): void {
    this.#storage.sql.exec(this.#prefixer.rewrite(sql));
  }

  prepare(sql: string): SqliteStatement {
    return new DurableObjectSqliteStatement(
      this.#storage.sql,
      this.#prefixer.rewrite(sql)
    );
  }

  transaction<T>(callback: () => T): T {
    return this.#storage.transactionSync(callback);
  }

  /** The object owns the database; there is nothing to close. */
  close(): void {}
}
