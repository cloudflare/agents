import type { JsonObject, JsonValue } from "./json";
import type { HarnessMessage, HarnessTurnResult } from "./runtime-types";

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

/** Durable state of one admitted harness turn. */
export type HarnessTurn = {
  readonly turnId: string;
  readonly streamId: string;
  readonly revisionId: number;
  readonly state: "queued" | "running" | "completed" | "failed";
  readonly prompt: string;
  readonly output: string | null;
  readonly error: string | null;
  readonly rounds: number | null;
  readonly isolateRun: number | null;
  readonly createdAt: number;
  readonly completedAt: number | null;
};

/** One trusted append-only journal record. */
export type JournalRecord = {
  readonly seq: number;
  readonly turnId: string | null;
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

type TurnRow = {
  turn_id: string;
  stream_id: string;
  revision_id: number;
  state: string;
  prompt: string;
  output: string | null;
  error: string | null;
  rounds: number | null;
  isolate_run: number | null;
  created_at: number;
  completed_at: number | null;
};

type MessageRow = {
  role: string;
  content: string;
};

type JournalRow = {
  seq: number;
  turn_id: string | null;
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

function turnState(value: string): HarnessTurn["state"] {
  if (
    value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "failed"
  ) {
    return value;
  }
  throw new Error(`Unknown harness turn state ${JSON.stringify(value)}`);
}

function turnFromRow(row: TurnRow): HarnessTurn {
  return {
    turnId: row.turn_id,
    streamId: row.stream_id,
    revisionId: row.revision_id,
    state: turnState(row.state),
    prompt: row.prompt,
    output: row.output,
    error: row.error,
    rounds: row.rounds,
    isolateRun: row.isolate_run,
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

/** SQLite persistence owned by the trusted self-modifying capability. */
export class SelfModifyingHarnessStore {
  readonly #storage: DurableObjectStorage;
  readonly #sql: SqlStorage;

  /** Bind the store to the owning Durable Object storage. */
  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    this.#sql = storage.sql;
  }

  /** Create every trusted metadata, history, turn, and effect table. */
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
      CREATE TABLE IF NOT EXISTS self_modifying_turns (
        turn_id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL UNIQUE,
        revision_id INTEGER NOT NULL,
        state TEXT NOT NULL,
        prompt TEXT NOT NULL,
        output TEXT,
        error TEXT,
        rounds INTEGER,
        isolate_run INTEGER,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS self_modifying_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(turn_id, role)
      );
      CREATE TABLE IF NOT EXISTS self_modifying_journal (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT,
        event_key TEXT UNIQUE,
        kind TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS self_modifying_effects (
        turn_id TEXT NOT NULL,
        effect_kind TEXT NOT NULL,
        effect_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        result_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (turn_id, effect_kind, effect_key)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS self_modifying_stream_events (
        turn_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        PRIMARY KEY (turn_id, event_key)
      ) WITHOUT ROWID;
    `);
  }

  /** Return the active compiled revision, or null before genesis. */
  activeBuild(): HarnessBuild | null {
    const rows = this.#sql
      .exec<BuildRow>(`
        SELECT r.revision_id, r.source_hash, r.parent_revision_id,
               r.note, r.created_at, b.main_module, b.modules_json,
               b.source_json
        FROM self_modifying_metadata m
        JOIN self_modifying_revisions r ON r.revision_id = CAST(m.value AS INTEGER)
        JOIN self_modifying_builds b ON b.source_hash = r.source_hash
        WHERE m.key = 'active_revision'
      `)
      .toArray();
    const row = rows.at(0);
    return row ? this.#buildFromRow(row) : null;
  }

  /** Return one compiled revision by its monotonic revision ID. */
  build(revisionId: number): HarnessBuild | null {
    const rows = this.#sql
      .exec<BuildRow>(
        `SELECT r.revision_id, r.source_hash, r.parent_revision_id,
                r.note, r.created_at, b.main_module, b.modules_json,
                b.source_json
         FROM self_modifying_revisions r
         JOIN self_modifying_builds b ON b.source_hash = r.source_hash
         WHERE r.revision_id = ?`,
        revisionId
      )
      .toArray();
    const row = rows.at(0);
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

  /** Admit one turn and append its user message atomically. */
  beginTurn(input: {
    readonly turnId: string;
    readonly streamId: string;
    readonly revisionId: number;
    readonly prompt: string;
  }): HarnessTurn {
    const now = Date.now();
    this.#storage.transactionSync(() => {
      this.#sql.exec(
        `INSERT OR IGNORE INTO self_modifying_turns
           (turn_id, stream_id, revision_id, state, prompt, created_at)
         VALUES (?, ?, ?, 'queued', ?, ?)`,
        input.turnId,
        input.streamId,
        input.revisionId,
        input.prompt,
        now
      );
      this.#sql.exec(
        `INSERT OR IGNORE INTO self_modifying_messages
           (turn_id, role, content, created_at)
         VALUES (?, 'user', ?, ?)`,
        input.turnId,
        input.prompt,
        now
      );
    });
    const turn = this.turn(input.turnId);
    if (!turn) throw new Error(`Turn ${input.turnId} was not admitted`);
    return turn;
  }

  /** Mark an admitted turn as executing. */
  markRunning(turnId: string): void {
    this.#sql.exec(
      "UPDATE self_modifying_turns SET state = 'running' WHERE turn_id = ? AND state = 'queued'",
      turnId
    );
  }

  /** Persist terminal output and its display-ready assistant message. */
  completeTurn(turnId: string, result: HarnessTurnResult): void {
    const now = Date.now();
    this.#storage.transactionSync(() => {
      this.#sql.exec(
        `UPDATE self_modifying_turns
         SET state = 'completed', output = ?, rounds = ?, isolate_run = ?,
             completed_at = ?
         WHERE turn_id = ?`,
        result.output,
        result.rounds,
        result.isolateRun,
        now,
        turnId
      );
      this.#sql.exec(
        `INSERT OR IGNORE INTO self_modifying_messages
           (turn_id, role, content, created_at)
         VALUES (?, 'assistant', ?, ?)`,
        turnId,
        result.output,
        now
      );
    });
  }

  /** Persist one terminal turn failure. */
  failTurn(turnId: string, error: string): void {
    this.#sql.exec(
      `UPDATE self_modifying_turns
       SET state = 'failed', error = ?, completed_at = ?
       WHERE turn_id = ?`,
      error,
      Date.now(),
      turnId
    );
  }

  /** Read one turn. */
  turn(turnId: string): HarnessTurn | null {
    const row = this.#sql
      .exec<TurnRow>(
        "SELECT * FROM self_modifying_turns WHERE turn_id = ?",
        turnId
      )
      .toArray()
      .at(0);
    return row ? turnFromRow(row) : null;
  }

  /** List recent turns newest first. */
  turns(limit = 30): HarnessTurn[] {
    return this.#sql
      .exec<TurnRow>(
        "SELECT * FROM self_modifying_turns ORDER BY created_at DESC LIMIT ?",
        limit
      )
      .toArray()
      .map(turnFromRow);
  }

  /** Read the bounded visible conversation before a given turn. */
  historyBefore(turnId: string, limit = 40): HarnessMessage[] {
    const rows = this.#sql
      .exec<MessageRow>(
        `SELECT role, content FROM (
           SELECT m.seq, m.role, m.content
           FROM self_modifying_messages m
           JOIN self_modifying_messages current ON current.turn_id = ? AND current.role = 'user'
           WHERE m.seq < current.seq
           ORDER BY m.seq DESC LIMIT ?
         ) ORDER BY seq ASC`,
        turnId,
        limit
      )
      .toArray();
    return rows.map((row) => {
      if (row.role !== "user" && row.role !== "assistant") {
        throw new Error(`Unknown harness message role ${row.role}`);
      }
      return { role: row.role, content: row.content };
    });
  }

  /** Append a trusted journal record, optionally once under a stable key. */
  journal(
    turnId: string | null,
    kind: string,
    data: JsonObject,
    eventKey?: string
  ): void {
    this.#sql.exec(
      `INSERT OR IGNORE INTO self_modifying_journal
         (turn_id, event_key, kind, data_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      turnId,
      eventKey ?? null,
      kind,
      JSON.stringify(data),
      Date.now()
    );
  }

  /** List trusted journal records newest first. */
  journalTail(limit = 100): JournalRecord[] {
    return this.#sql
      .exec<JournalRow>(
        "SELECT * FROM self_modifying_journal ORDER BY seq DESC LIMIT ?",
        limit
      )
      .toArray()
      .map((row) => ({
        seq: row.seq,
        turnId: row.turn_id,
        kind: row.kind,
        data: JSON.parse(row.data_json) as JsonObject,
        createdAt: row.created_at
      }));
  }

  /** Read model or tool effect evidence. */
  effect(turnId: string, kind: string, key: string): EffectRecord | null {
    const row = this.#sql
      .exec<EffectRow>(
        `SELECT request_hash, state, result_json FROM self_modifying_effects
         WHERE turn_id = ? AND effect_kind = ? AND effect_key = ?`,
        turnId,
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
    turnId: string,
    kind: string,
    key: string,
    requestHash: string
  ): void {
    const now = Date.now();
    this.#sql.exec(
      `INSERT OR IGNORE INTO self_modifying_effects
         (turn_id, effect_kind, effect_key, request_hash, state,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      turnId,
      kind,
      key,
      requestHash,
      now,
      now
    );
  }

  /** Settle one effect with a JSON result. */
  completeEffect(
    turnId: string,
    kind: string,
    key: string,
    result: JsonValue
  ): void {
    this.#sql.exec(
      `UPDATE self_modifying_effects SET state = 'completed', result_json = ?, updated_at = ?
       WHERE turn_id = ? AND effect_kind = ? AND effect_key = ?`,
      JSON.stringify(result),
      Date.now(),
      turnId,
      kind,
      key
    );
  }

  /** Claim one event key before projecting it into Streams. */
  claimStreamEvent(turnId: string, eventKey: string): boolean {
    const cursor = this.#sql.exec(
      `INSERT OR IGNORE INTO self_modifying_stream_events (turn_id, event_key)
       VALUES (?, ?)`,
      turnId,
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
