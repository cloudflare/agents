import type { SessionMessage } from "agents/sessions";
import type { JsonObject, JsonValue } from "./json";
import type { HarnessMessage } from "./runtime-types";

/** Newest messages read for a transcript page, before the byte budget. */
const TRANSCRIPT_ROW_LIMIT = 200;

/** One activated source revision. */
export type HarnessRevision = {
  readonly revisionId: number;
  readonly sourceHash: string;
  readonly parentRevisionId: number | null;
  readonly note: string;
  readonly createdAt: number;
};

/** A compiled source snapshot loaded by one turn. */
export type HarnessBuild = HarnessRevision & {
  readonly mainModule: string;
  readonly modules: Readonly<Record<string, string>>;
  readonly source: Readonly<Record<string, string>>;
};

/**
 * What the runtime keeps about one operation beside the operation row the
 * Harness base already owns: the input it must replay after an eviction,
 * the revision a turn is pinned to, and the two isolate metrics the base
 * cannot know.
 */
export type SelfModifyingOperation = {
  readonly operationId: string;
  readonly kind: string;
  readonly payload: JsonValue;
  readonly revisionId: number | null;
  readonly rounds: number | null;
  readonly isolateRun: number | null;
  readonly createdAt: number;
};

/** One trusted append-only journal record. */
export type JournalRecord = {
  readonly seq: number;
  readonly operationId: string | null;
  readonly kind: string;
  readonly data: JsonObject;
  readonly createdAt: number;
};

/** Stored evidence for an external model or tool effect. */
export type EffectRecord = {
  readonly requestHash: string;
  readonly state: "pending" | "completed";
  readonly result: JsonValue | null;
};

type RevisionRow = {
  revision_id: number;
  source_hash: string;
  parent_revision_id: number | null;
  note: string;
  created_at: number;
};

type BuildRow = RevisionRow & {
  main_module: string;
  modules_json: string;
  source_json: string;
};

type OperationRow = {
  operation_id: string;
  kind: string;
  payload_json: string;
  revision_id: number | null;
  rounds: number | null;
  isolate_run: number | null;
  created_at: number;
};

type MessageRow = {
  operation_id: string;
  role: string;
  content: string;
};

type JournalRow = {
  seq: number;
  operation_id: string | null;
  kind: string;
  data_json: string;
  created_at: number;
};

type EffectRow = {
  request_hash: string;
  state: string;
  result_json: string | null;
};

function revisionFromRow(row: RevisionRow): HarnessRevision {
  return {
    revisionId: row.revision_id,
    sourceHash: row.source_hash,
    parentRevisionId: row.parent_revision_id,
    note: row.note,
    createdAt: row.created_at
  };
}

function operationFromRow(row: OperationRow): SelfModifyingOperation {
  return {
    operationId: row.operation_id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as JsonValue,
    revisionId: row.revision_id,
    rounds: row.rounds,
    isolateRun: row.isolate_run,
    createdAt: row.created_at
  };
}

function journalFromRow(row: JournalRow): JournalRecord {
  return {
    seq: row.seq,
    operationId: row.operation_id,
    kind: row.kind,
    data: JSON.parse(row.data_json) as JsonObject,
    createdAt: row.created_at
  };
}

function messageRole(value: string): HarnessMessage["role"] {
  if (value === "user" || value === "assistant") return value;
  throw new Error(`Unknown harness message role ${JSON.stringify(value)}`);
}

/** SQLite persistence owned by the trusted self-modifying runtime. */
export class SelfModifyingHarnessStore {
  readonly #storage: DurableObjectStorage;
  readonly #sql: SqlStorage;

  /** Bind the store to the owning Durable Object storage. */
  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    this.#sql = storage.sql;
  }

  /** Create every trusted metadata, history, operation, and effect table. */
  ensureSchema(): void {
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS self_modifying_builds (
        source_hash TEXT PRIMARY KEY,
        source_json TEXT NOT NULL,
        main_module TEXT NOT NULL,
        modules_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS self_modifying_revisions (
        revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_hash TEXT NOT NULL,
        parent_revision_id INTEGER,
        activation_key TEXT NOT NULL UNIQUE,
        note TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS self_modifying_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS self_modifying_operations (
        operation_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        revision_id INTEGER,
        rounds INTEGER,
        isolate_run INTEGER,
        created_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS self_modifying_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(operation_id, role)
      );
      CREATE TABLE IF NOT EXISTS self_modifying_journal (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT,
        event_key TEXT UNIQUE,
        kind TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS self_modifying_effects (
        operation_id TEXT NOT NULL,
        effect_kind TEXT NOT NULL,
        effect_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        result_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (operation_id, effect_kind, effect_key)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS self_modifying_stream_events (
        operation_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        PRIMARY KEY (operation_id, event_key)
      ) WITHOUT ROWID;
    `);
  }

  /** Return the active compiled revision, or null before genesis. */
  activeBuild(): HarnessBuild | null {
    const row = this.#sql
      .exec<BuildRow>(`
        SELECT r.revision_id, r.source_hash, r.parent_revision_id,
               r.note, r.created_at, b.main_module, b.modules_json,
               b.source_json
        FROM self_modifying_metadata m
        JOIN self_modifying_revisions r ON r.revision_id = CAST(m.value AS INTEGER)
        JOIN self_modifying_builds b ON b.source_hash = r.source_hash
        WHERE m.key = 'active_revision'
      `)
      .toArray()
      .at(0);
    return row ? this.#buildFromRow(row) : null;
  }

  /** Return one compiled revision by its monotonic revision ID. */
  build(revisionId: number): HarnessBuild | null {
    const row = this.#sql
      .exec<BuildRow>(
        `SELECT r.revision_id, r.source_hash, r.parent_revision_id,
                r.note, r.created_at, b.main_module, b.modules_json,
                b.source_json
         FROM self_modifying_revisions r
         JOIN self_modifying_builds b ON b.source_hash = r.source_hash
         WHERE r.revision_id = ?`,
        revisionId
      )
      .toArray()
      .at(0);
    return row ? this.#buildFromRow(row) : null;
  }

  /** Read the revision already created by one idempotent activation. */
  revisionByActivationKey(activationKey: string): HarnessRevision | null {
    const row = this.#sql
      .exec<RevisionRow>(
        `SELECT revision_id, source_hash, parent_revision_id, note, created_at
         FROM self_modifying_revisions WHERE activation_key = ?`,
        activationKey
      )
      .toArray()
      .at(0);
    return row ? revisionFromRow(row) : null;
  }

  /** List activation history newest first. */
  revisions(limit = 50): HarnessRevision[] {
    return this.#sql
      .exec<RevisionRow>(
        `SELECT revision_id, source_hash, parent_revision_id, note, created_at
         FROM self_modifying_revisions ORDER BY revision_id DESC LIMIT ?`,
        limit
      )
      .toArray()
      .map(revisionFromRow);
  }

  /** Persist a content-addressed build and append a forward revision. */
  activate(input: {
    readonly sourceHash: string;
    readonly source: Readonly<Record<string, string>>;
    readonly mainModule: string;
    readonly modules: Readonly<Record<string, string>>;
    readonly note: string;
    readonly activationKey: string;
  }): HarnessRevision {
    return this.#storage.transactionSync(() => {
      const existing = this.#sql
        .exec<RevisionRow>(
          `SELECT revision_id, source_hash, parent_revision_id, note, created_at
           FROM self_modifying_revisions WHERE activation_key = ?`,
          input.activationKey
        )
        .toArray()
        .at(0);
      if (existing) return revisionFromRow(existing);

      const parentRevisionId = this.activeBuild()?.revisionId ?? null;
      const now = Date.now();
      this.#sql.exec(
        `INSERT OR IGNORE INTO self_modifying_builds
           (source_hash, source_json, main_module, modules_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        input.sourceHash,
        JSON.stringify(input.source),
        input.mainModule,
        JSON.stringify(input.modules),
        now
      );
      this.#sql.exec(
        `INSERT INTO self_modifying_revisions
           (source_hash, parent_revision_id, activation_key, note, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        input.sourceHash,
        parentRevisionId,
        input.activationKey,
        input.note,
        now
      );
      const revisionId = this.#sql
        .exec<{ revision_id: number }>(
          "SELECT last_insert_rowid() AS revision_id"
        )
        .one().revision_id;
      this.#sql.exec(
        `INSERT INTO self_modifying_metadata (key, value) VALUES ('active_revision', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        String(revisionId)
      );
      return {
        revisionId,
        sourceHash: input.sourceHash,
        parentRevisionId,
        note: input.note,
        createdAt: now
      };
    });
  }

  /**
   * Record one operation's replayable input before it starts, and append a
   * turn's user message in the same transaction.
   */
  beginOperation(input: {
    readonly operationId: string;
    readonly kind: string;
    readonly payload: JsonValue;
    readonly revisionId?: number;
    readonly prompt?: string;
  }): void {
    const now = Date.now();
    this.#storage.transactionSync(() => {
      this.#sql.exec(
        `INSERT OR IGNORE INTO self_modifying_operations
           (operation_id, kind, payload_json, revision_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        input.operationId,
        input.kind,
        JSON.stringify(input.payload),
        input.revisionId ?? null,
        now
      );
      if (input.prompt === undefined) return;
      this.#sql.exec(
        `INSERT OR IGNORE INTO self_modifying_messages
           (operation_id, role, content, created_at)
         VALUES (?, 'user', ?, ?)`,
        input.operationId,
        input.prompt,
        now
      );
    });
  }

  /** Read one recorded operation. */
  operation(operationId: string): SelfModifyingOperation | null {
    const row = this.#sql
      .exec<OperationRow>(
        "SELECT * FROM self_modifying_operations WHERE operation_id = ?",
        operationId
      )
      .toArray()
      .at(0);
    return row ? operationFromRow(row) : null;
  }

  /**
   * Persist a turn's display-ready assistant message, and the two isolate
   * metrics the Harness base does not record when the turn produced them.
   */
  completeTurn(
    operationId: string,
    result: {
      readonly output: string;
      readonly rounds?: number;
      readonly isolateRun?: number;
    }
  ): void {
    const now = Date.now();
    this.#storage.transactionSync(() => {
      this.#sql.exec(
        `UPDATE self_modifying_operations
         SET rounds = COALESCE(?, rounds), isolate_run = COALESCE(?, isolate_run)
         WHERE operation_id = ?`,
        result.rounds ?? null,
        result.isolateRun ?? null,
        operationId
      );
      this.#sql.exec(
        `INSERT OR IGNORE INTO self_modifying_messages
           (operation_id, role, content, created_at)
         VALUES (?, 'assistant', ?, ?)`,
        operationId,
        result.output,
        now
      );
    });
  }

  /** Read the bounded visible conversation before a given turn. */
  historyBefore(operationId: string, limit = 40): HarnessMessage[] {
    return this.#sql
      .exec<MessageRow>(
        `SELECT operation_id, role, content FROM (
           SELECT m.seq, m.operation_id, m.role, m.content
           FROM self_modifying_messages m
           JOIN self_modifying_messages current
             ON current.operation_id = ? AND current.role = 'user'
           WHERE m.seq < current.seq
           ORDER BY m.seq DESC LIMIT ?
         ) ORDER BY seq ASC`,
        operationId,
        limit
      )
      .toArray()
      .map((row) => ({ role: messageRole(row.role), content: row.content }));
  }

  /** The user-visible transcript, oldest first, within a byte budget. */
  transcript(maxBytes: number): SessionMessage[] {
    const rows = this.#sql
      .exec<MessageRow>(
        `SELECT operation_id, role, content FROM self_modifying_messages
         ORDER BY seq DESC LIMIT ?`,
        TRANSCRIPT_ROW_LIMIT
      )
      .toArray();
    const messages: SessionMessage[] = [];
    let bytes = 0;
    for (const row of rows) {
      bytes += row.content.length;
      if (bytes > maxBytes && messages.length > 0) break;
      messages.push({
        id: `${row.role}:${row.operation_id}`,
        role: row.role,
        parts: [{ type: "text", text: row.content }]
      });
    }
    return messages.reverse();
  }

  /**
   * Append a trusted journal record, optionally once under a stable key.
   * Returns the stored record, or null when that key was already written.
   */
  journal(
    operationId: string | null,
    kind: string,
    data: JsonObject,
    eventKey?: string
  ): JournalRecord | null {
    const now = Date.now();
    const cursor = this.#sql.exec(
      `INSERT OR IGNORE INTO self_modifying_journal
         (operation_id, event_key, kind, data_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      operationId,
      eventKey ?? null,
      kind,
      JSON.stringify(data),
      now
    );
    if (cursor.rowsWritten === 0) return null;
    const seq = this.#sql
      .exec<{ seq: number }>("SELECT last_insert_rowid() AS seq")
      .one().seq;
    return { seq, operationId, kind, data, createdAt: now };
  }

  /** List trusted journal records newest first. */
  journalTail(limit = 100): JournalRecord[] {
    return this.#sql
      .exec<JournalRow>(
        "SELECT * FROM self_modifying_journal ORDER BY seq DESC LIMIT ?",
        limit
      )
      .toArray()
      .map(journalFromRow);
  }

  /** Read model or tool effect evidence. */
  effect(operationId: string, kind: string, key: string): EffectRecord | null {
    const row = this.#sql
      .exec<EffectRow>(
        `SELECT request_hash, state, result_json FROM self_modifying_effects
         WHERE operation_id = ? AND effect_kind = ? AND effect_key = ?`,
        operationId,
        kind,
        key
      )
      .toArray()
      .at(0);
    if (!row) return null;
    if (row.state !== "pending" && row.state !== "completed") {
      throw new Error(`Unknown effect state ${row.state}`);
    }
    return {
      requestHash: row.request_hash,
      state: row.state,
      result: row.result_json
        ? (JSON.parse(row.result_json) as JsonValue)
        : null
    };
  }

  /** Record an effect intent before external work starts. */
  beginEffect(
    operationId: string,
    kind: string,
    key: string,
    requestHash: string
  ): void {
    const now = Date.now();
    this.#sql.exec(
      `INSERT OR IGNORE INTO self_modifying_effects
         (operation_id, effect_kind, effect_key, request_hash, state,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      operationId,
      kind,
      key,
      requestHash,
      now,
      now
    );
  }

  /** Settle one effect with a JSON result. */
  completeEffect(
    operationId: string,
    kind: string,
    key: string,
    result: JsonValue
  ): void {
    this.#sql.exec(
      `UPDATE self_modifying_effects SET state = 'completed', result_json = ?, updated_at = ?
       WHERE operation_id = ? AND effect_kind = ? AND effect_key = ?`,
      JSON.stringify(result),
      Date.now(),
      operationId,
      kind,
      key
    );
  }

  /** Claim one event key before projecting it into the operation's log. */
  claimStreamEvent(operationId: string, eventKey: string): boolean {
    const cursor = this.#sql.exec(
      `INSERT OR IGNORE INTO self_modifying_stream_events (operation_id, event_key)
       VALUES (?, ?)`,
      operationId,
      eventKey
    );
    return cursor.rowsWritten > 0;
  }

  #buildFromRow(row: BuildRow): HarnessBuild {
    return {
      ...revisionFromRow(row),
      mainModule: row.main_module,
      modules: JSON.parse(row.modules_json) as Record<string, string>,
      source: JSON.parse(row.source_json) as Record<string, string>
    };
  }
}
