import type { Usage } from "@earendil-works/pi-ai";
import type { SessionMetadata } from "@earendil-works/pi-agent-core";

interface PiSqliteRunResult {
  readonly changes: number;
  readonly lastInsertRowid?: number;
}

interface PiSqliteStatement {
  run(...params: unknown[]): PiSqliteRunResult;
  get<Row extends object>(...params: unknown[]): Row | undefined;
  all<Row extends object>(...params: unknown[]): Row[];
  iterate<Row extends object>(...params: unknown[]): Iterable<Row>;
}

interface PiSqliteDatabase {
  exec(query: string): void;
  prepare(query: string): PiSqliteStatement;
  transaction<Result>(callback: () => Result): Result;
  close(): void;
}

const TABLE_NAMES = {
  branch_entries: "cf_agents_pi_branch_entries",
  branch_meta: "cf_agents_pi_branch_meta",
  entries: "cf_agents_pi_entries",
  list_values: "cf_agents_pi_list_values",
  scalar_values: "cf_agents_pi_scalar_values",
  sessions: "cf_agents_pi_sessions",
  usage_ledger: "cf_agents_pi_usage_ledger"
} as const;

const TABLE_NAME_PATTERN = new RegExp(
  `\\b(${Object.keys(TABLE_NAMES).join("|")})\\b`,
  "g"
);

const PI_SESSION_STORAGE_VERSION = 1;
const PI_SESSION_ID_KEY = "cf_agents:pi-harness:session-id";

const PI_SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS cf_agents_pi_sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  parent_session_id TEXT,
  storage_version INTEGER NOT NULL,
  metadata TEXT,
  message_count INTEGER NOT NULL,
  usage_payload TEXT NOT NULL,
  next_seq INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS cf_agents_pi_entries (
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  parent_id TEXT,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  custom_type TEXT,
  timestamp INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS cf_agents_pi_entry_parent
  ON cf_agents_pi_entries(session_id, parent_id);
CREATE INDEX IF NOT EXISTS cf_agents_pi_entry_seq
  ON cf_agents_pi_entries(session_id, seq, type);

CREATE TABLE IF NOT EXISTS cf_agents_pi_scalar_values (
  session_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (session_id, namespace, key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS cf_agents_pi_list_values (
  session_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (session_id, namespace, key, seq)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS cf_agents_pi_usage_ledger (
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  entry_id TEXT,
  adjustment INTEGER NOT NULL,
  usage TEXT NOT NULL,
  details TEXT,
  PRIMARY KEY (session_id, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS cf_agents_pi_usage_seq
  ON cf_agents_pi_usage_ledger(session_id, seq);

CREATE TRIGGER IF NOT EXISTS cf_agents_pi_entries_validate
BEFORE INSERT ON cf_agents_pi_entries
BEGIN
  SELECT RAISE(ABORT, 'missing parent entry')
  WHERE NEW.parent_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM cf_agents_pi_entries
      WHERE session_id = NEW.session_id AND id = NEW.parent_id
    );

  SELECT RAISE(ABORT, 'duplicate entry or usage id')
  WHERE EXISTS (
    SELECT 1 FROM cf_agents_pi_usage_ledger
    WHERE session_id = NEW.session_id AND id = NEW.id
  );
END;

CREATE TRIGGER IF NOT EXISTS cf_agents_pi_usage_validate
BEFORE INSERT ON cf_agents_pi_usage_ledger
BEGIN
  SELECT RAISE(ABORT, 'duplicate entry or usage id')
  WHERE EXISTS (
    SELECT 1 FROM cf_agents_pi_entries
    WHERE session_id = NEW.session_id AND id = NEW.id
  );
END;

CREATE TABLE IF NOT EXISTS cf_agents_pi_branch_entries (
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  entry_seq INTEGER NOT NULL,
  entry_type TEXT NOT NULL,
  PRIMARY KEY (session_id, branch_id, entry_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS cf_agents_pi_be_seq
  ON cf_agents_pi_branch_entries(
    session_id, branch_id, entry_seq, entry_id, entry_type
  );
CREATE INDEX IF NOT EXISTS cf_agents_pi_be_type
  ON cf_agents_pi_branch_entries(
    session_id, branch_id, entry_type, entry_seq, entry_id
  );
CREATE INDEX IF NOT EXISTS cf_agents_pi_be_entry
  ON cf_agents_pi_branch_entries(session_id, entry_id);

CREATE TABLE IF NOT EXISTS cf_agents_pi_branch_meta (
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  tip_entry_id TEXT NOT NULL,
  tip_seq INTEGER NOT NULL,
  base_branch_id TEXT,
  base_seq INTEGER,
  PRIMARY KEY (session_id, branch_id)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS cf_agents_pi_bm_tip
  ON cf_agents_pi_branch_meta(session_id, tip_entry_id);
`;

type PiSessionRow = {
  id: string;
  created_at: number;
  storage_version: number;
};

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0
    }
  };
}

function transformSql(query: string): string {
  return query.replace(TABLE_NAME_PATTERN, (name) => {
    const table = TABLE_NAMES[name as keyof typeof TABLE_NAMES];
    if (!table) throw new Error(`Unknown pi SQLite table ${name}`);
    return table;
  });
}

function toSqlValue(value: unknown): SqlStorageValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    value instanceof ArrayBuffer
  ) {
    return value;
  }
  throw new TypeError(`Unsupported pi SQLite binding: ${typeof value}`);
}

class DurableObjectSqliteStatement implements PiSqliteStatement {
  readonly #storage: DurableObjectStorage;
  readonly #query: string;

  constructor(storage: DurableObjectStorage, query: string) {
    this.#storage = storage;
    this.#query = transformSql(query);
  }

  run(...params: unknown[]): PiSqliteRunResult {
    this.#storage.sql.exec(this.#query, ...params.map(toSqlValue));
    const changed = this.#storage.sql
      .exec<{ changes: number }>("SELECT changes() AS changes")
      .one();
    return { changes: changed.changes };
  }

  get<TRow extends object>(...params: unknown[]): TRow | undefined {
    const row = this.#storage.sql
      .exec<Record<string, SqlStorageValue>>(
        this.#query,
        ...params.map(toSqlValue)
      )
      .toArray()[0];
    // SAFETY: SqliteStorage owns every query and declares the corresponding
    // row shape. Workerd returns columns as SqlStorageValue records.
    return row as TRow | undefined;
  }

  all<TRow extends object>(...params: unknown[]): TRow[] {
    const rows = this.#storage.sql
      .exec<Record<string, SqlStorageValue>>(
        this.#query,
        ...params.map(toSqlValue)
      )
      .toArray();
    // SAFETY: SqliteStorage owns every query and declares the corresponding
    // row shape. Workerd returns columns as SqlStorageValue records.
    return rows as TRow[];
  }

  iterate<TRow extends object>(...params: unknown[]): Iterable<TRow> {
    return this.all<TRow>(...params);
  }
}

/**
 * Adapt Durable Object SQLite to pi's synchronous SQLite database contract.
 *
 * Pi's generic table identifiers are rewritten into the `cf_agents_pi_*`
 * namespace so the harness can share one database with other capabilities.
 */
export class DurableObjectPiDatabase implements PiSqliteDatabase {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  exec(query: string): void {
    this.#storage.sql.exec(transformSql(query));
  }

  prepare(query: string): PiSqliteStatement {
    return new DurableObjectSqliteStatement(this.#storage, query);
  }

  transaction<T>(callback: () => T): T {
    return this.#storage.transactionSync(callback);
  }

  close(): void {
    // Durable Object storage belongs to the host and outlives this adapter.
  }
}

/** Create or restore the one pi Session owned by this Durable Object. */
export async function ensurePiSession(
  storage: DurableObjectStorage
): Promise<SessionMetadata> {
  let sessionId = await storage.get<string>(PI_SESSION_ID_KEY);
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    await storage.put(PI_SESSION_ID_KEY, sessionId);
  }

  storage.transactionSync(() => {
    storage.sql.exec(PI_SESSION_SCHEMA);
    const existing = storage.sql
      .exec<PiSessionRow>(
        `SELECT id, created_at, storage_version
         FROM cf_agents_pi_sessions WHERE id = ?`,
        sessionId
      )
      .toArray()[0];
    if (existing) return;

    storage.sql.exec(
      `INSERT INTO cf_agents_pi_sessions
        (id, created_at, parent_session_id, storage_version, metadata,
         message_count, usage_payload, next_seq)
       VALUES (?, ?, NULL, ?, NULL, 0, ?, 1)`,
      sessionId,
      Date.now(),
      PI_SESSION_STORAGE_VERSION,
      JSON.stringify(emptyUsage())
    );
  });

  const row = storage.sql
    .exec<PiSessionRow>(
      `SELECT id, created_at, storage_version
       FROM cf_agents_pi_sessions WHERE id = ?`,
      sessionId
    )
    .one();
  if (row.storage_version !== PI_SESSION_STORAGE_VERSION) {
    throw new Error(
      `Unsupported pi Session storage version ${row.storage_version}`
    );
  }
  return {
    id: row.id,
    createdAt: row.created_at,
    storageVersion: row.storage_version
  };
}
