import {
  INPUT_CHUNK_CHARS,
  MAX_ANSWER_CHARS,
  MAX_CONTEXT_OUTPUT_CHARS,
  MAX_INPUT_CHARS,
  MAX_KERNEL_VALUE_CHARS,
  applyHarnessEdits,
  buildHarnessOverview,
  emptyHarnessState,
  inputSource,
  isRecord,
  normalizeHarnessApply,
  requireString,
  rollbackHarness,
  splitInput,
  truncateText,
  truncateUnknown,
  type HarnessApplyResult,
  type HarnessEntry,
  type HarnessKind,
  type HarnessState,
  type InputSource
} from "./core";

export type InputMeta = {
  id: string;
  scope: string;
  taskChars: number;
  materialChars: number;
  createdAt: number;
};

export type MessageRecord = {
  id: number;
  scope: string;
  role: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: number;
};

export type AnswerRecord = {
  content: string;
  executionId: string;
  createdAt: number;
};

export type ChildStatus =
  | "admitted"
  | "running"
  | "completed"
  | "error"
  | "interrupted";

export type ChildRecord = {
  id: string;
  parentScope: string;
  scope: string;
  depth: number;
  name: string;
  mode: "query" | "persistent";
  status: ChildStatus;
  prompt: string;
  inputId: string;
  answer?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export type HarnessRevision = {
  revision: number;
  reason: string;
  evidence: string;
  metadata: Record<string, unknown>;
  createdAt: number;
};

export type ExecutionAuditRecord = {
  id: string;
  status: string;
  code: string;
  result?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export type RlmOperationKind = "query" | "spawn" | "followup";
export type RlmOperationStatus = "claimed" | "admitted" | "completed" | "error";

export type RlmOperationRecord = {
  id: string;
  rootInputId: string;
  kind: RlmOperationKind;
  key: string;
  argsHash: string;
  childId: string;
  turnInputId: string;
  sequence: number;
  status: RlmOperationStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export type RlmOperationClaim = {
  created: boolean;
  operation: RlmOperationRecord;
};

export type RootRequestKind = "think" | "refine";

export type RootRequestRecord = {
  requestId: string;
  kind: RootRequestKind;
  argsHash: string;
  inputId: string;
  createdAt: number;
};

export type SnippetPromotionRecord = {
  name: string;
  executionId: string;
  status: "pending" | "completed";
  createdAt: number;
  completedAt?: number;
};

type SqlRow = Record<string, ArrayBuffer | string | number | null>;

function rowString(row: SqlRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : String(value ?? "");
}

function rowNumber(row: SqlRow, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : Number(value ?? 0);
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseHarness(value: unknown): HarnessState {
  if (typeof value !== "string") return emptyHarnessState();
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.schema !== 1) return emptyHarnessState();
    return parsed as HarnessState;
  } catch {
    return emptyHarnessState();
  }
}

function safeJson(value: unknown): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new Error(
      `value must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (encoded === undefined) {
    throw new Error("value must not be undefined");
  }
  return encoded;
}

export class ThinkStore {
  readonly #storage: DurableObjectStorage;
  readonly #sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    this.#sql = storage.sql;
    this.#initialize();
  }

  #initialize(): void {
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS inputs (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        task_chars INTEGER NOT NULL,
        material_chars INTEGER NOT NULL,
        activated_at INTEGER,
        activation_sequence INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS input_chunks (
        input_id TEXT NOT NULL,
        source TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (input_id, source, chunk_index)
      );
      CREATE INDEX IF NOT EXISTS input_chunks_lookup
        ON input_chunks (input_id, source, chunk_index);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_scope_id
        ON messages (scope, id DESC);
      CREATE TABLE IF NOT EXISTS turn_transcript_messages (
        input_id TEXT NOT NULL,
        role TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (input_id, role)
      );
      CREATE TABLE IF NOT EXISTS kernel_state (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE IF NOT EXISTS answers (
        input_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS execution_scopes (
        execution_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        input_id TEXT NOT NULL DEFAULT '',
        run_mode TEXT NOT NULL DEFAULT 'think',
        status TEXT NOT NULL DEFAULT 'running',
        code TEXT NOT NULL DEFAULT '',
        result TEXT NOT NULL DEFAULT 'null',
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS execution_scopes_scope_created
        ON execution_scopes (scope, created_at DESC);
      CREATE TABLE IF NOT EXISTS harness_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS harness_revisions (
        revision INTEGER PRIMARY KEY,
        state TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS harness_turn_writes (
        input_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS children (
        id TEXT PRIMARY KEY,
        parent_scope TEXT NOT NULL,
        scope TEXT NOT NULL,
        depth INTEGER NOT NULL,
        name TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        input_id TEXT NOT NULL,
        answer TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (parent_scope, name)
      );
      CREATE INDEX IF NOT EXISTS children_parent_created
        ON children (parent_scope, created_at DESC);
      CREATE TABLE IF NOT EXISTS child_completions (
        child_id TEXT NOT NULL,
        input_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (child_id, input_id)
      );
      CREATE TABLE IF NOT EXISTS rlm_budgets (
        input_id TEXT PRIMARY KEY,
        used INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rlm_operations (
        id TEXT PRIMARY KEY,
        root_input_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        operation_key TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        child_id TEXT NOT NULL,
        turn_input_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS rlm_operations_turn_input
        ON rlm_operations (turn_input_id);
      CREATE INDEX IF NOT EXISTS rlm_operations_root_created
        ON rlm_operations (root_input_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS rlm_operation_executions (
        operation_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (operation_id, execution_id)
      );
      CREATE TABLE IF NOT EXISTS root_requests (
        request_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        input_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snippet_promotions (
        name TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
    `);

    this.#ensureColumn("answers", "execution_id", "TEXT NOT NULL DEFAULT ''");
    this.#ensureColumn("inputs", "activated_at", "INTEGER");
    this.#ensureColumn("inputs", "activation_sequence", "INTEGER");
    this.#ensureColumn("children", "depth", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn(
      "execution_scopes",
      "input_id",
      "TEXT NOT NULL DEFAULT ''"
    );
    this.#ensureColumn(
      "execution_scopes",
      "run_mode",
      "TEXT NOT NULL DEFAULT 'think'"
    );
    this.#ensureColumn(
      "execution_scopes",
      "status",
      "TEXT NOT NULL DEFAULT 'running'"
    );
    this.#ensureColumn(
      "execution_scopes",
      "updated_at",
      "INTEGER NOT NULL DEFAULT 0"
    );
    this.#ensureColumn("execution_scopes", "code", "TEXT NOT NULL DEFAULT ''");
    this.#ensureColumn(
      "execution_scopes",
      "result",
      "TEXT NOT NULL DEFAULT 'null'"
    );
    this.#ensureColumn("execution_scopes", "error", "TEXT");
    this.#ensureColumn(
      "rlm_operations",
      "sequence",
      "INTEGER NOT NULL DEFAULT 0"
    );

    const state = emptyHarnessState();
    const now = Date.now();
    this.#storage.transactionSync(() => {
      this.#sql.exec(
        "INSERT OR IGNORE INTO harness_state (singleton, revision, state, updated_at) VALUES (1, 0, ?, ?)",
        JSON.stringify(state),
        now
      );
      this.#sql.exec(
        "INSERT OR IGNORE INTO harness_revisions (revision, state, reason, evidence, metadata, created_at) VALUES (0, ?, ?, ?, ?, ?)",
        JSON.stringify(state),
        "initial harness",
        "",
        "{}",
        now
      );
    });
  }

  #first(query: string, ...bindings: unknown[]): SqlRow | undefined {
    return this.#sql.exec(query, ...bindings).toArray()[0];
  }

  #ensureColumn(table: string, column: string, definition: string): void {
    const exists = this.#sql
      .exec(`PRAGMA table_info(${table})`)
      .toArray()
      .some((row) => rowString(row, "name") === column);
    if (!exists) {
      this.#sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  #inputContent(id: string, source: InputSource): string {
    return this.#sql
      .exec(
        "SELECT content FROM input_chunks WHERE input_id = ? AND source = ? ORDER BY chunk_index",
        id,
        source
      )
      .toArray()
      .map((row) => rowString(row, "content"))
      .join("");
  }

  #activationSequence(id: string): number | undefined {
    const row = this.#first(
      "SELECT activation_sequence FROM inputs WHERE id = ?",
      id
    );
    if (!row || row.activation_sequence === null) return undefined;
    const value = row.activation_sequence;
    return typeof value === "number" ? value : Number(value);
  }

  addInputWithId(
    scope: string,
    id: string,
    task: string,
    material: string
  ): InputMeta {
    requireString(scope, "scope", { min: 1, max: 180 });
    requireString(id, "inputId", { min: 1, max: 120 });
    requireString(task, "task", { min: 1, max: MAX_INPUT_CHARS });
    requireString(material, "material", { max: MAX_INPUT_CHARS });
    if (task.length + material.length > MAX_INPUT_CHARS) {
      throw new Error(
        `task and material together may contain at most ${MAX_INPUT_CHARS} characters`
      );
    }
    const existing = this.inputMetaOrUndefined(id);
    if (existing) {
      if (
        existing.scope !== scope ||
        existing.taskChars !== task.length ||
        existing.materialChars !== material.length ||
        this.#inputContent(id, "task") !== task ||
        this.#inputContent(id, "material") !== material
      ) {
        throw new Error(`input id ${id} was reused with different data`);
      }
      return existing;
    }
    const createdAt = Date.now();
    this.#storage.transactionSync(() => {
      this.#sql.exec(
        "INSERT INTO inputs (id, scope, task_chars, material_chars, created_at) VALUES (?, ?, ?, ?, ?)",
        id,
        scope,
        task.length,
        material.length,
        createdAt
      );
      for (const [source, value] of [
        ["task", task],
        ["material", material]
      ] as const) {
        for (const [index, content] of splitInput(value).entries()) {
          this.#sql.exec(
            "INSERT INTO input_chunks (input_id, source, chunk_index, content) VALUES (?, ?, ?, ?)",
            id,
            source,
            index,
            content
          );
        }
      }
    });
    return {
      id,
      scope,
      taskChars: task.length,
      materialChars: material.length,
      createdAt
    };
  }

  activateInput(id: string, scope: string): void {
    this.#storage.transactionSync(() => {
      const meta = this.inputMeta(id);
      if (meta.scope !== scope) {
        throw new Error(`input ${id} does not belong to scope ${scope}`);
      }
      if (this.#activationSequence(id) !== undefined) return;
      const sequence = rowNumber(
        this.#sql
          .exec(
            "SELECT COALESCE(MAX(activation_sequence), 0) + 1 AS next FROM inputs WHERE scope = ?",
            scope
          )
          .one(),
        "next"
      );
      this.#sql.exec(
        "UPDATE inputs SET activated_at = ?, activation_sequence = ? WHERE id = ? AND activation_sequence IS NULL",
        Date.now(),
        sequence,
        id
      );
    });
  }

  inputPayload(id: string): { prompt: string; material: string } {
    this.inputMeta(id);
    return {
      prompt: this.#inputContent(id, "task"),
      material: this.#inputContent(id, "material")
    };
  }

  inputVisibleFrom(scope: string, currentInputId: string, id: string): boolean {
    const current = this.inputMeta(currentInputId);
    const candidate = this.inputMeta(id);
    if (current.scope !== scope || candidate.scope !== scope) return false;
    const currentSequence = this.#activationSequence(currentInputId);
    const candidateSequence = this.#activationSequence(id);
    return (
      currentSequence !== undefined &&
      candidateSequence !== undefined &&
      candidateSequence <= currentSequence
    );
  }

  rlmCalls(inputId: string): number {
    const row = this.#first(
      "SELECT used FROM rlm_budgets WHERE input_id = ?",
      inputId
    );
    return row ? rowNumber(row, "used") : 0;
  }

  claimRlmOperation(options: {
    id: string;
    rootInputId: string;
    kind: RlmOperationKind;
    key: string;
    argsHash: string;
    childId: string;
    turnInputId: string;
    sourceExecutionId: string;
    maximum: number;
  }): RlmOperationClaim {
    return this.#storage.transactionSync(() => {
      const existing = this.rlmOperation(options.id);
      if (existing) {
        if (
          existing.rootInputId !== options.rootInputId ||
          existing.kind !== options.kind ||
          existing.key !== options.key ||
          existing.argsHash !== options.argsHash ||
          existing.childId !== options.childId ||
          existing.turnInputId !== options.turnInputId
        ) {
          throw new Error(
            `RLM key ${options.key} was reused with different arguments`
          );
        }
        this.#sql.exec(
          "INSERT OR IGNORE INTO rlm_operation_executions (operation_id, execution_id, created_at) VALUES (?, ?, ?)",
          options.id,
          options.sourceExecutionId,
          Date.now()
        );
        return { created: false, operation: existing };
      }

      const budget = this.#first(
        "SELECT used FROM rlm_budgets WHERE input_id = ?",
        options.rootInputId
      );
      const used = budget ? rowNumber(budget, "used") : 0;
      if (used >= options.maximum) {
        throw new Error(
          `recursive call budget exhausted (${used}/${options.maximum})`
        );
      }

      const now = Date.now();
      const next = used + 1;
      const sequence = rowNumber(
        this.#sql
          .exec(
            "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM rlm_operations WHERE root_input_id = ?",
            options.rootInputId
          )
          .one(),
        "next"
      );
      this.#sql.exec(
        "INSERT INTO rlm_budgets (input_id, used, updated_at) VALUES (?, ?, ?) ON CONFLICT(input_id) DO UPDATE SET used = excluded.used, updated_at = excluded.updated_at",
        options.rootInputId,
        next,
        now
      );
      this.#sql.exec(
        "INSERT INTO rlm_operations (id, root_input_id, kind, operation_key, args_hash, child_id, turn_input_id, sequence, status, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', NULL, ?, ?)",
        options.id,
        options.rootInputId,
        options.kind,
        options.key,
        options.argsHash,
        options.childId,
        options.turnInputId,
        sequence,
        now,
        now
      );
      this.#sql.exec(
        "INSERT INTO rlm_operation_executions (operation_id, execution_id, created_at) VALUES (?, ?, ?)",
        options.id,
        options.sourceExecutionId,
        now
      );
      return { created: true, operation: this.rlmOperation(options.id)! };
    });
  }

  rlmOperation(id: string): RlmOperationRecord | undefined {
    const row = this.#first(
      "SELECT id, root_input_id, kind, operation_key, args_hash, child_id, turn_input_id, sequence, status, error, created_at, updated_at FROM rlm_operations WHERE id = ?",
      id
    );
    return row ? this.#operationFromRow(row) : undefined;
  }

  rlmOperationForTurn(turnInputId: string): RlmOperationRecord | undefined {
    const row = this.#first(
      "SELECT id, root_input_id, kind, operation_key, args_hash, child_id, turn_input_id, sequence, status, error, created_at, updated_at FROM rlm_operations WHERE turn_input_id = ?",
      turnInputId
    );
    return row ? this.#operationFromRow(row) : undefined;
  }

  markRlmOperation(
    id: string,
    status: Exclude<RlmOperationStatus, "claimed">,
    error?: string
  ): RlmOperationRecord {
    return this.#storage.transactionSync(() => {
      const current = this.rlmOperation(id);
      if (!current) throw new Error(`RLM operation ${id} was not found`);
      if (current.status === "completed" || current.status === "error") {
        return current;
      }
      this.#sql.exec(
        "UPDATE rlm_operations SET status = ?, error = ?, updated_at = ? WHERE id = ?",
        status,
        status === "error"
          ? truncateText(
              error ?? "RLM operation failed",
              MAX_CONTEXT_OUTPUT_CHARS
            )
          : null,
        Date.now(),
        id
      );
      return this.rlmOperation(id)!;
    });
  }

  markRlmOperationForTurn(
    turnInputId: string,
    status: "completed" | "error",
    error?: string
  ): RlmOperationRecord | undefined {
    const operation = this.rlmOperationForTurn(turnInputId);
    return operation
      ? this.markRlmOperation(operation.id, status, error)
      : undefined;
  }

  claimRootRequest(options: {
    requestId: string;
    kind: RootRequestKind;
    argsHash: string;
    inputId: string;
  }): RootRequestRecord {
    return this.#storage.transactionSync(() => {
      const existing = this.rootRequest(options.requestId);
      if (existing) {
        if (
          existing.kind !== options.kind ||
          existing.argsHash !== options.argsHash ||
          existing.inputId !== options.inputId
        ) {
          throw new Error(
            `requestId ${options.requestId} was reused with different arguments`
          );
        }
        return existing;
      }
      const now = Date.now();
      this.#sql.exec(
        "INSERT INTO root_requests (request_id, kind, args_hash, input_id, created_at) VALUES (?, ?, ?, ?, ?)",
        options.requestId,
        options.kind,
        options.argsHash,
        options.inputId,
        now
      );
      return {
        requestId: options.requestId,
        kind: options.kind,
        argsHash: options.argsHash,
        inputId: options.inputId,
        createdAt: now
      };
    });
  }

  rootRequest(requestId: string): RootRequestRecord | undefined {
    const row = this.#first(
      "SELECT request_id, kind, args_hash, input_id, created_at FROM root_requests WHERE request_id = ?",
      requestId
    );
    if (!row) return undefined;
    return {
      requestId: rowString(row, "request_id"),
      kind: rowString(row, "kind") === "refine" ? "refine" : "think",
      argsHash: rowString(row, "args_hash"),
      inputId: rowString(row, "input_id"),
      createdAt: rowNumber(row, "created_at")
    };
  }

  inputMeta(id: string): InputMeta {
    const meta = this.inputMetaOrUndefined(id);
    if (!meta) throw new Error(`input ${id} was not found`);
    return meta;
  }

  inputMetaOrUndefined(id: string): InputMeta | undefined {
    const row = this.#first(
      "SELECT id, scope, task_chars, material_chars, created_at FROM inputs WHERE id = ?",
      id
    );
    if (!row) return undefined;
    return {
      id: rowString(row, "id"),
      scope: rowString(row, "scope"),
      taskChars: rowNumber(row, "task_chars"),
      materialChars: rowNumber(row, "material_chars"),
      createdAt: rowNumber(row, "created_at")
    };
  }

  inputs(scope: string, currentInputId: string, limit = 20): InputMeta[] {
    const currentSequence = this.#activationSequence(currentInputId);
    if (currentSequence === undefined) {
      throw new Error(`input ${currentInputId} is not active`);
    }
    return this.#sql
      .exec(
        "SELECT id, scope, task_chars, material_chars, created_at FROM inputs WHERE scope = ? AND activation_sequence IS NOT NULL AND activation_sequence <= ? ORDER BY activation_sequence DESC LIMIT ?",
        scope,
        currentSequence,
        Math.max(1, Math.min(100, limit))
      )
      .toArray()
      .map((row) => ({
        id: rowString(row, "id"),
        scope: rowString(row, "scope"),
        taskChars: rowNumber(row, "task_chars"),
        materialChars: rowNumber(row, "material_chars"),
        createdAt: rowNumber(row, "created_at")
      }));
  }

  inputSlice(
    id: string,
    rawSource: unknown,
    rawStart: unknown,
    rawLength: unknown
  ): {
    source: InputSource;
    start: number;
    end: number;
    total: number;
    content: string;
  } {
    const source = inputSource(rawSource);
    const meta = this.inputMeta(id);
    const total = source === "task" ? meta.taskChars : meta.materialChars;
    const start = Math.max(
      0,
      Math.min(total, typeof rawStart === "number" ? Math.trunc(rawStart) : 0)
    );
    const requested =
      typeof rawLength === "number" ? Math.trunc(rawLength) : 4_000;
    const length = Math.max(1, Math.min(MAX_CONTEXT_OUTPUT_CHARS, requested));
    const end = Math.min(total, start + length);
    if (start === end) return { source, start, end, total, content: "" };

    const firstChunk = Math.floor(start / INPUT_CHUNK_CHARS);
    const lastChunk = Math.floor((end - 1) / INPUT_CHUNK_CHARS);
    const rows = this.#sql
      .exec(
        "SELECT chunk_index, content FROM input_chunks WHERE input_id = ? AND source = ? AND chunk_index BETWEEN ? AND ? ORDER BY chunk_index",
        id,
        source,
        firstChunk,
        lastChunk
      )
      .toArray();
    const joined = rows.map((row) => rowString(row, "content")).join("");
    const localStart = start - firstChunk * INPUT_CHUNK_CHARS;
    return {
      source,
      start,
      end,
      total,
      content: joined.slice(localStart, localStart + (end - start))
    };
  }

  searchInput(
    id: string,
    rawSource: unknown,
    rawQuery: unknown,
    rawLimit: unknown
  ): Array<{ start: number; end: number; snippet: string }> {
    const source = inputSource(rawSource);
    const query = requireString(rawQuery, "query", { min: 2, max: 500 });
    const limit = Math.max(
      1,
      Math.min(20, typeof rawLimit === "number" ? Math.trunc(rawLimit) : 8)
    );
    this.inputMeta(id);
    const matches: Array<{ start: number; end: number; snippet: string }> = [];
    const needle = query.toLocaleLowerCase();
    let carry = "";
    for (const row of this.#sql.exec(
      "SELECT chunk_index, content FROM input_chunks WHERE input_id = ? AND source = ? ORDER BY chunk_index",
      id,
      source
    )) {
      const chunkIndex = rowNumber(row, "chunk_index");
      const content = rowString(row, "content");
      const combined = carry + content;
      const haystack = combined.toLocaleLowerCase();
      let cursor = 0;
      while (matches.length < limit) {
        const found = haystack.indexOf(needle, cursor);
        if (found < 0) break;
        // Ignore a match wholly inside the carry: it was emitted with the
        // preceding chunk. A match crossing the boundary is emitted here.
        if (found + needle.length > carry.length) {
          const snippetStart = Math.max(0, found - 180);
          const snippetEnd = Math.min(
            combined.length,
            found + query.length + 320
          );
          const absolute =
            chunkIndex * INPUT_CHUNK_CHARS - carry.length + found;
          matches.push({
            start: absolute,
            end: absolute + query.length,
            snippet: combined.slice(snippetStart, snippetEnd)
          });
        }
        cursor = found + Math.max(1, query.length);
      }
      carry = combined.slice(-Math.max(0, query.length - 1));
      if (matches.length >= limit) break;
    }
    return matches;
  }

  addMessage(
    scope: string,
    role: string,
    content: string,
    metadata: Record<string, unknown> = {}
  ): number {
    requireString(content, "message content", { max: 200_000 });
    const cursor = this.#sql.exec(
      "INSERT INTO messages (scope, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?)",
      scope,
      role,
      content,
      safeJson(metadata),
      Date.now()
    );
    return Number(
      cursor.rowsWritten > 0
        ? this.#sql.exec("SELECT last_insert_rowid() AS id").one().id
        : 0
    );
  }

  recordTurnMessage(
    scope: string,
    inputId: string,
    role: "user" | "assistant",
    content: string,
    metadata: Record<string, unknown> = {}
  ): boolean {
    return this.#storage.transactionSync(() => {
      const existing = this.#first(
        "SELECT message_id FROM turn_transcript_messages WHERE input_id = ? AND role = ?",
        inputId,
        role
      );
      if (existing) return false;
      const messageId = this.addMessage(scope, role, content, {
        ...metadata,
        inputId
      });
      this.#sql.exec(
        "INSERT INTO turn_transcript_messages (input_id, role, message_id, created_at) VALUES (?, ?, ?, ?)",
        inputId,
        role,
        messageId,
        Date.now()
      );
      return true;
    });
  }

  history(
    scope: string,
    options: { limit?: number; beforeId?: number; contentChars?: number } = {}
  ): MessageRecord[] {
    const limit = Math.max(1, Math.min(50, options.limit ?? 12));
    const contentChars = Math.max(
      200,
      Math.min(MAX_CONTEXT_OUTPUT_CHARS, options.contentChars ?? 2_000)
    );
    const rows = options.beforeId
      ? this.#sql
          .exec(
            "SELECT id, scope, role, content, metadata, created_at FROM messages WHERE scope = ? AND id < ? ORDER BY id DESC LIMIT ?",
            scope,
            options.beforeId,
            limit
          )
          .toArray()
      : this.#sql
          .exec(
            "SELECT id, scope, role, content, metadata, created_at FROM messages WHERE scope = ? ORDER BY id DESC LIMIT ?",
            scope,
            limit
          )
          .toArray();
    return rows.map((row) => ({
      id: rowNumber(row, "id"),
      scope: rowString(row, "scope"),
      role: rowString(row, "role"),
      content: truncateText(rowString(row, "content"), contentChars),
      metadata: parseObject(rowString(row, "metadata")),
      createdAt: rowNumber(row, "created_at")
    }));
  }

  message(scope: string, id: number): MessageRecord | undefined {
    const row = this.#first(
      "SELECT id, scope, role, content, metadata, created_at FROM messages WHERE scope = ? AND id = ?",
      scope,
      id
    );
    if (!row) return undefined;
    return {
      id: rowNumber(row, "id"),
      scope: rowString(row, "scope"),
      role: rowString(row, "role"),
      content: rowString(row, "content"),
      metadata: parseObject(rowString(row, "metadata")),
      createdAt: rowNumber(row, "created_at")
    };
  }

  messageSlice(
    scope: string,
    id: number,
    rawStart: unknown,
    rawLength: unknown
  ):
    | { start: number; end: number; total: number; content: string }
    | undefined {
    const message = this.message(scope, id);
    if (!message) return undefined;
    const start = Math.max(
      0,
      Math.min(
        message.content.length,
        typeof rawStart === "number" ? Math.trunc(rawStart) : 0
      )
    );
    const length = Math.max(
      1,
      Math.min(
        MAX_CONTEXT_OUTPUT_CHARS,
        typeof rawLength === "number" ? Math.trunc(rawLength) : 4_000
      )
    );
    const end = Math.min(message.content.length, start + length);
    return {
      start,
      end,
      total: message.content.length,
      content: message.content.slice(start, end)
    };
  }

  searchHistory(
    scope: string,
    rawQuery: unknown,
    rawLimit: unknown
  ): MessageRecord[] {
    const query = requireString(rawQuery, "query", { min: 2, max: 500 });
    const limit = Math.max(
      1,
      Math.min(20, typeof rawLimit === "number" ? Math.trunc(rawLimit) : 8)
    );
    return this.#sql
      .exec(
        "SELECT id, scope, role, content, metadata, created_at FROM messages WHERE scope = ? AND instr(lower(content), lower(?)) > 0 ORDER BY id DESC LIMIT ?",
        scope,
        query,
        limit
      )
      .toArray()
      .map((row) => ({
        id: rowNumber(row, "id"),
        scope: rowString(row, "scope"),
        role: rowString(row, "role"),
        content: truncateText(rowString(row, "content"), 2_000),
        metadata: parseObject(rowString(row, "metadata")),
        createdAt: rowNumber(row, "created_at")
      }));
  }

  messageCount(scope: string): number {
    const row = this.#sql
      .exec("SELECT COUNT(*) AS count FROM messages WHERE scope = ?", scope)
      .one();
    return rowNumber(row, "count");
  }

  setKernelValue(scope: string, rawKey: unknown, value: unknown): unknown {
    const key = requireString(rawKey, "key", { min: 1, max: 120 });
    const encoded = safeJson(value);
    if (encoded.length > MAX_KERNEL_VALUE_CHARS) {
      throw new Error(
        `kernel value exceeds the ${MAX_KERNEL_VALUE_CHARS}-character limit`
      );
    }
    const existing = this.#first(
      "SELECT key FROM kernel_state WHERE scope = ? AND key = ?",
      scope,
      key
    );
    if (!existing) {
      const count = this.#sql
        .exec(
          "SELECT COUNT(*) AS count FROM kernel_state WHERE scope = ?",
          scope
        )
        .one();
      if (rowNumber(count, "count") >= 256) {
        throw new Error("kernel state is limited to 256 keys per agent scope");
      }
    }
    this.#sql.exec(
      "INSERT INTO kernel_state (scope, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      scope,
      key,
      encoded,
      Date.now()
    );
    return value;
  }

  kernelValue(scope: string, rawKey: unknown): unknown {
    const key = requireString(rawKey, "key", { min: 1, max: 120 });
    const row = this.#first(
      "SELECT value FROM kernel_state WHERE scope = ? AND key = ?",
      scope,
      key
    );
    if (!row) return null;
    try {
      return JSON.parse(rowString(row, "value")) as unknown;
    } catch {
      return null;
    }
  }

  kernelKeys(
    scope: string
  ): Array<{ key: string; chars: number; updatedAt: number }> {
    return this.#sql
      .exec(
        "SELECT key, length(value) AS chars, updated_at FROM kernel_state WHERE scope = ? ORDER BY updated_at DESC",
        scope
      )
      .toArray()
      .map((row) => ({
        key: rowString(row, "key"),
        chars: rowNumber(row, "chars"),
        updatedAt: rowNumber(row, "updated_at")
      }));
  }

  deleteKernelValue(scope: string, rawKey: unknown): boolean {
    const key = requireString(rawKey, "key", { min: 1, max: 120 });
    return (
      this.#sql.exec(
        "DELETE FROM kernel_state WHERE scope = ? AND key = ?",
        scope,
        key
      ).rowsWritten > 0
    );
  }

  finish(
    scope: string,
    inputId: string,
    rawContent: unknown,
    rawExecutionId: unknown
  ): string {
    const content = requireString(rawContent, "content", {
      min: 1,
      max: MAX_ANSWER_CHARS
    });
    const executionId = requireString(rawExecutionId, "executionId", {
      min: 1,
      max: 120
    });
    this.#sql.exec(
      "INSERT INTO answers (input_id, scope, execution_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
      inputId,
      scope,
      executionId,
      content,
      Date.now()
    );
    return content;
  }

  answer(inputId: string): string | undefined {
    return this.answerRecord(inputId)?.content;
  }

  answerRecord(inputId: string): AnswerRecord | undefined {
    const row = this.#first(
      "SELECT execution_id, content, created_at FROM answers WHERE input_id = ?",
      inputId
    );
    return row
      ? {
          executionId: rowString(row, "execution_id"),
          content: rowString(row, "content"),
          createdAt: rowNumber(row, "created_at")
        }
      : undefined;
  }

  clearAnswer(inputId: string, executionId: string): void {
    this.#sql.exec(
      "DELETE FROM answers WHERE input_id = ? AND execution_id = ?",
      inputId,
      executionId
    );
  }

  bindExecution(options: {
    executionId: string;
    scope: string;
    inputId: string;
    runMode: "think" | "refine";
  }): void {
    const now = Date.now();
    this.#sql.exec(
      "INSERT INTO execution_scopes (execution_id, scope, input_id, run_mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?) ON CONFLICT(execution_id) DO UPDATE SET scope = excluded.scope, input_id = excluded.input_id, run_mode = excluded.run_mode, status = CASE WHEN execution_scopes.status IN ('completed', 'error', 'rejected', 'rolled_back') THEN execution_scopes.status ELSE 'running' END, updated_at = excluded.updated_at",
      options.executionId,
      options.scope,
      options.inputId,
      options.runMode,
      now,
      now
    );
  }

  finalizeExecution(options: {
    executionId: string;
    scope: string;
    inputId: string;
    runMode: "think" | "refine";
    status: "completed" | "error" | "rejected" | "rolled_back";
  }): void {
    const now = Date.now();
    this.#sql.exec(
      "INSERT INTO execution_scopes (execution_id, scope, input_id, run_mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(execution_id) DO UPDATE SET scope = excluded.scope, input_id = excluded.input_id, run_mode = excluded.run_mode, status = excluded.status, updated_at = excluded.updated_at",
      options.executionId,
      options.scope,
      options.inputId,
      options.runMode,
      options.status,
      now,
      now
    );
  }

  recordExecution(options: {
    executionId: string;
    scope: string;
    inputId: string;
    runMode: "think" | "refine";
    status: string;
    code: string;
    result?: unknown;
    error?: string;
  }): void {
    if (!options.executionId) return;
    const now = Date.now();
    this.#sql.exec(
      "INSERT INTO execution_scopes (execution_id, scope, input_id, run_mode, status, code, result, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(execution_id) DO UPDATE SET scope = excluded.scope, input_id = excluded.input_id, run_mode = excluded.run_mode, status = excluded.status, code = excluded.code, result = excluded.result, error = excluded.error, updated_at = excluded.updated_at",
      options.executionId,
      options.scope,
      options.inputId,
      options.runMode,
      options.status,
      truncateText(options.code, 4_000),
      safeJson(options.result ?? null),
      options.error ? truncateText(options.error, 4_000) : null,
      now,
      now
    );
  }

  executionStatus(executionId: string): string | undefined {
    const row = this.#first(
      "SELECT status FROM execution_scopes WHERE execution_id = ?",
      executionId
    );
    return row ? rowString(row, "status") : undefined;
  }

  executionMode(executionId: string): "think" | "refine" | undefined {
    const row = this.#first(
      "SELECT run_mode FROM execution_scopes WHERE execution_id = ?",
      executionId
    );
    if (!row) return undefined;
    return rowString(row, "run_mode") === "refine" ? "refine" : "think";
  }

  executionBelongs(
    executionId: string,
    scope: string,
    inputId: string
  ): boolean {
    return (
      this.#first(
        "SELECT execution_id FROM execution_scopes WHERE execution_id = ? AND scope = ? AND input_id = ?",
        executionId,
        scope,
        inputId
      ) !== undefined
    );
  }

  executionIds(scope: string, inputId: string, limit = 100): string[] {
    return this.#sql
      .exec(
        "SELECT execution_id FROM (SELECT execution_id, created_at FROM execution_scopes WHERE scope = ? AND input_id = ? ORDER BY created_at DESC, execution_id DESC LIMIT ?) ORDER BY created_at ASC, execution_id ASC",
        scope,
        inputId,
        Math.max(1, Math.min(100, limit))
      )
      .toArray()
      .map((row) => rowString(row, "execution_id"));
  }

  executionAudit(scope: string, limit = 20): ExecutionAuditRecord[] {
    return this.#sql
      .exec(
        "SELECT execution_id, status, code, result, error, created_at, updated_at FROM execution_scopes WHERE scope = ? ORDER BY created_at DESC, execution_id DESC LIMIT ?",
        scope,
        Math.max(1, Math.min(50, limit))
      )
      .toArray()
      .map((row) => {
        const error = rowString(row, "error");
        return {
          id: rowString(row, "execution_id"),
          status: rowString(row, "status"),
          code: rowString(row, "code"),
          result: parseJson(rowString(row, "result")),
          error: error || undefined,
          createdAt: rowNumber(row, "created_at"),
          updatedAt: rowNumber(row, "updated_at")
        };
      });
  }

  harness(): HarnessState {
    const row = this.#sql
      .exec("SELECT state FROM harness_state WHERE singleton = 1")
      .one();
    return parseHarness(rowString(row, "state"));
  }

  harnessOverview(): string {
    return buildHarnessOverview(this.harness());
  }

  adoptSnippetNames(names: string[]): void {
    // The example exposes no other snippet writer. Reconcile the facet's
    // catalog before every claim so a save-applied/ledger-not-finalized crash
    // closes to completed without ever reopening an immutable name.
    const now = Date.now();
    this.#storage.transactionSync(() => {
      for (const name of names) {
        this.#sql.exec(
          "INSERT INTO snippet_promotions (name, execution_id, status, created_at, completed_at) VALUES (?, '', 'completed', ?, ?) ON CONFLICT(name) DO UPDATE SET status = 'completed', completed_at = COALESCE(snippet_promotions.completed_at, excluded.completed_at)",
          name,
          now,
          now
        );
      }
    });
  }

  claimSnippetPromotion(
    name: string,
    executionId: string,
    maximum: number
  ): SnippetPromotionRecord {
    return this.#storage.transactionSync(() => {
      const existing = this.#snippetPromotion(name);
      if (existing) {
        throw new Error(
          `snippet ${name} already exists or is reserved; use a new versioned name`
        );
      }
      const count = rowNumber(
        this.#sql
          .exec("SELECT COUNT(*) AS count FROM snippet_promotions")
          .one(),
        "count"
      );
      if (count >= maximum) {
        throw new Error(
          `a session may contain at most ${maximum} promoted or reserved snippets`
        );
      }
      const now = Date.now();
      this.#sql.exec(
        "INSERT INTO snippet_promotions (name, execution_id, status, created_at, completed_at) VALUES (?, ?, 'pending', ?, NULL)",
        name,
        executionId,
        now
      );
      return this.#snippetPromotion(name)!;
    });
  }

  completeSnippetPromotion(name: string): SnippetPromotionRecord {
    const now = Date.now();
    this.#sql.exec(
      "UPDATE snippet_promotions SET status = 'completed', completed_at = ? WHERE name = ? AND status = 'pending'",
      now,
      name
    );
    const record = this.#snippetPromotion(name);
    if (!record) throw new Error(`snippet promotion ${name} was not found`);
    return record;
  }

  snippetPromotions(): SnippetPromotionRecord[] {
    return this.#sql
      .exec(
        "SELECT name, execution_id, status, created_at, completed_at FROM snippet_promotions ORDER BY created_at, name"
      )
      .toArray()
      .map((row) => this.#snippetPromotionFromRow(row));
  }

  #snippetPromotion(name: string): SnippetPromotionRecord | undefined {
    const row = this.#first(
      "SELECT name, execution_id, status, created_at, completed_at FROM snippet_promotions WHERE name = ?",
      name
    );
    return row ? this.#snippetPromotionFromRow(row) : undefined;
  }

  #snippetPromotionFromRow(row: SqlRow): SnippetPromotionRecord {
    return {
      name: rowString(row, "name"),
      executionId: rowString(row, "execution_id"),
      status:
        rowString(row, "status") === "completed" ? "completed" : "pending",
      createdAt: rowNumber(row, "created_at"),
      completedAt:
        row.completed_at === null ? undefined : rowNumber(row, "completed_at")
    };
  }

  harnessEntries(kind?: HarnessKind, limit = 20): HarnessEntry[] {
    const state = this.harness();
    const kinds = kind
      ? [kind]
      : (["prompt", "memory", "skill", "subagent"] as const);
    return kinds
      .flatMap((item) => Object.values(state.entries[item]))
      .slice(0, Math.max(1, Math.min(50, limit)));
  }

  harnessEntry(kind: HarnessKind, id: string): HarnessEntry | undefined {
    const entries = this.harness().entries[kind];
    return Object.hasOwn(entries, id) ? entries[id] : undefined;
  }

  applyHarness(rawRequest: unknown, turnInputId?: string): HarnessApplyResult {
    const request = normalizeHarnessApply(rawRequest);
    return this.#storage.transactionSync(() => {
      const current = this.harness();
      const now = Date.now();
      this.#claimHarnessTurnWrite(turnInputId, now);
      const refinementId = `refine_${now}_${crypto.randomUUID().slice(0, 8)}`;
      const result = applyHarnessEdits(current, request, now, refinementId);
      this.#sql.exec(
        "UPDATE harness_state SET revision = ?, state = ?, updated_at = ? WHERE singleton = 1",
        result.state.revision,
        JSON.stringify(result.state),
        now
      );
      this.#sql.exec(
        "INSERT INTO harness_revisions (revision, state, reason, evidence, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        result.state.revision,
        JSON.stringify(result.state),
        request.trigger,
        request.evidence,
        JSON.stringify({
          expectedOutcome: request.expectedOutcome,
          edits: request.edits,
          before: result.before,
          after: result.after
        }),
        now
      );
      this.#sql.exec(
        "DELETE FROM harness_revisions WHERE revision != 0 AND revision NOT IN (SELECT revision FROM harness_revisions ORDER BY revision DESC LIMIT 100)"
      );
      return result;
    });
  }

  harnessRevisions(limit = 20): HarnessRevision[] {
    return this.#sql
      .exec(
        "SELECT revision, reason, evidence, metadata, created_at FROM harness_revisions ORDER BY revision DESC LIMIT ?",
        Math.max(1, Math.min(100, limit))
      )
      .toArray()
      .map((row) => ({
        revision: rowNumber(row, "revision"),
        reason: rowString(row, "reason"),
        evidence: rowString(row, "evidence"),
        metadata: {
          summary: truncateUnknown(
            parseObject(rowString(row, "metadata")),
            4_000
          )
        },
        createdAt: rowNumber(row, "created_at")
      }));
  }

  rollbackHarness(
    rawRevision: unknown,
    rawEvidence: unknown,
    turnInputId?: string
  ): HarnessState {
    const revision =
      typeof rawRevision === "number" ? Math.trunc(rawRevision) : Number.NaN;
    if (!Number.isInteger(revision) || revision < 0) {
      throw new Error("targetRevision must be a non-negative integer");
    }
    const evidence = requireString(rawEvidence, "evidence", {
      min: 1,
      max: 8_000
    });
    return this.#storage.transactionSync(() => {
      const targetRow = this.#first(
        "SELECT state FROM harness_revisions WHERE revision = ?",
        revision
      );
      if (!targetRow)
        throw new Error(`harness revision ${revision} was not found`);
      const current = this.harness();
      const target = parseHarness(rowString(targetRow, "state"));
      const now = Date.now();
      this.#claimHarnessTurnWrite(turnInputId, now);
      const next = rollbackHarness(
        current,
        target,
        revision,
        evidence,
        now,
        `rollback_${now}_${crypto.randomUUID().slice(0, 8)}`
      );
      this.#sql.exec(
        "UPDATE harness_state SET revision = ?, state = ?, updated_at = ? WHERE singleton = 1",
        next.revision,
        JSON.stringify(next),
        now
      );
      this.#sql.exec(
        "INSERT INTO harness_revisions (revision, state, reason, evidence, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        next.revision,
        JSON.stringify(next),
        `rollback to revision ${revision}`,
        evidence,
        JSON.stringify({ targetRevision: revision }),
        now
      );
      this.#sql.exec(
        "DELETE FROM harness_revisions WHERE revision != 0 AND revision NOT IN (SELECT revision FROM harness_revisions ORDER BY revision DESC LIMIT 100)"
      );
      return next;
    });
  }

  #claimHarnessTurnWrite(turnInputId: string | undefined, now: number): void {
    if (!turnInputId) return;
    const existing = this.#first(
      "SELECT input_id FROM harness_turn_writes WHERE input_id = ?",
      turnInputId
    );
    if (existing) {
      throw new Error("this refinement turn already mutated the harness once");
    }
    this.#sql.exec(
      "INSERT INTO harness_turn_writes (input_id, created_at) VALUES (?, ?)",
      turnInputId,
      now
    );
  }

  uniqueChildName(parentScope: string, preferred: string): string {
    const base = preferred.slice(0, 80) || "child";
    let candidate = base;
    let suffix = 2;
    while (
      this.#first(
        "SELECT id FROM children WHERE parent_scope = ? AND name = ?",
        parentScope,
        candidate
      )
    ) {
      candidate = `${base.slice(0, 72)}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  createChild(options: {
    id: string;
    parentScope: string;
    scope: string;
    depth: number;
    name: string;
    mode: "query" | "persistent";
    prompt: string;
    inputId: string;
  }): ChildRecord {
    const now = Date.now();
    this.#sql.exec(
      "INSERT INTO children (id, parent_scope, scope, depth, name, mode, status, prompt, input_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'admitted', ?, ?, ?, ?)",
      options.id,
      options.parentScope,
      options.scope,
      options.depth,
      options.name,
      options.mode,
      options.prompt,
      options.inputId,
      now,
      now
    );
    return this.child(options.id)!;
  }

  setChildStatus(
    id: string,
    status: ChildStatus,
    options: {
      answer?: string;
      error?: string;
      inputId?: string;
      prompt?: string;
      expectedInputId?: string;
      expectedStatus?: ChildStatus;
      preserveResult?: boolean;
    } = {}
  ): boolean {
    if (
      options.inputId !== undefined &&
      options.expectedInputId === undefined
    ) {
      throw new Error("changing a child input requires expectedInputId");
    }
    const expectedInputId = options.expectedInputId ?? null;
    const expectedStatus = options.expectedStatus ?? null;
    const preserveResult = options.preserveResult ? 1 : 0;
    const advancesHead =
      options.inputId !== undefined &&
      expectedInputId !== null &&
      options.inputId !== expectedInputId;
    if (advancesHead && expectedStatus === null) {
      throw new Error("advancing a child input requires expectedStatus");
    }
    const protectsTerminalHead =
      (status === "admitted" || status === "running") && !advancesHead ? 1 : 0;
    return (
      this.#sql.exec(
        "UPDATE children SET status = ?, answer = CASE WHEN ? = 1 THEN answer ELSE ? END, error = CASE WHEN ? = 1 THEN error ELSE ? END, input_id = COALESCE(?, input_id), prompt = COALESCE(?, prompt), updated_at = ? WHERE id = ? AND (? IS NULL OR input_id = ?) AND (? IS NULL OR status = ?) AND (? = 0 OR status NOT IN ('completed', 'error', 'interrupted'))",
        status,
        preserveResult,
        options.answer ?? null,
        preserveResult,
        options.error
          ? truncateText(options.error, MAX_CONTEXT_OUTPUT_CHARS)
          : null,
        options.inputId ?? null,
        options.prompt ?? null,
        Date.now(),
        id,
        expectedInputId,
        expectedInputId,
        expectedStatus,
        expectedStatus,
        protectsTerminalHead
      ).rowsWritten > 0
    );
  }

  completeChildTurn(options: {
    childId: string;
    inputId: string;
    answer: string;
    executionIds: string[];
  }): boolean {
    return this.#storage.transactionSync(() => {
      const child = this.child(options.childId);
      if (!child) throw new Error(`child ${options.childId} was not found`);
      if (child.inputId !== options.inputId) return false;
      const inserted = this.#sql.exec(
        "INSERT OR IGNORE INTO child_completions (child_id, input_id, created_at) VALUES (?, ?, ?)",
        options.childId,
        options.inputId,
        Date.now()
      );
      if (inserted.rowsWritten === 0) {
        this.setChildStatus(options.childId, "completed", {
          answer: options.answer,
          inputId: options.inputId,
          expectedInputId: options.inputId
        });
        return false;
      }
      this.addMessage(child.scope, "assistant", options.answer, {
        inputId: options.inputId,
        executionIds: options.executionIds
      });
      this.setChildStatus(options.childId, "completed", {
        answer: options.answer,
        inputId: options.inputId,
        expectedInputId: options.inputId
      });
      this.addMessage(
        child.parentScope,
        "child_result",
        truncateText(options.answer, MAX_CONTEXT_OUTPUT_CHARS),
        {
          childId: options.childId,
          childScope: child.scope,
          inputId: options.inputId,
          answerChars: options.answer.length
        }
      );
      return true;
    });
  }

  failChildTurn(options: {
    childId: string;
    inputId: string;
    error: string;
  }): void {
    const message = truncateText(options.error, MAX_CONTEXT_OUTPUT_CHARS);
    this.#storage.transactionSync(() => {
      const child = this.child(options.childId);
      if (
        !child ||
        child.status === "completed" ||
        child.status === "error" ||
        child.status === "interrupted" ||
        child.inputId !== options.inputId
      ) {
        return;
      }
      const updated = this.#sql.exec(
        "UPDATE children SET status = 'error', answer = NULL, error = ?, updated_at = ? WHERE id = ? AND input_id = ? AND status NOT IN ('completed', 'error', 'interrupted')",
        message,
        Date.now(),
        options.childId,
        options.inputId
      );
      if (updated.rowsWritten === 0) return;
      this.addMessage(child.parentScope, "child_error", message, {
        childId: options.childId,
        childScope: child.scope,
        inputId: options.inputId
      });
    });
  }

  child(id: string): ChildRecord | undefined {
    const row = this.#first(
      "SELECT id, parent_scope, scope, depth, name, mode, status, prompt, input_id, answer, error, created_at, updated_at FROM children WHERE id = ?",
      id
    );
    return row ? this.#childFromRow(row) : undefined;
  }

  children(parentScope: string, limit = 20): ChildRecord[] {
    return this.#sql
      .exec(
        "SELECT id, parent_scope, scope, depth, name, mode, status, prompt, input_id, answer, error, created_at, updated_at FROM children WHERE parent_scope = ? ORDER BY created_at DESC LIMIT ?",
        parentScope,
        Math.max(1, Math.min(100, limit))
      )
      .toArray()
      .map((row) => this.#childFromRow(row));
  }

  childAnswerInfo(id: string): {
    ready: boolean;
    chars: number;
    status: ChildStatus;
  } {
    const child = this.child(id);
    if (!child) throw new Error(`child ${id} was not found`);
    return {
      ready: child.answer !== undefined,
      chars: child.answer?.length ?? 0,
      status: child.status
    };
  }

  childAnswerSlice(
    id: string,
    rawStart: unknown,
    rawLength: unknown
  ): { start: number; end: number; total: number; content: string } {
    const child = this.child(id);
    if (!child) throw new Error(`child ${id} was not found`);
    const answer = child.answer ?? "";
    const start = Math.max(
      0,
      Math.min(
        answer.length,
        typeof rawStart === "number" ? Math.trunc(rawStart) : 0
      )
    );
    const length = Math.max(
      1,
      Math.min(
        MAX_CONTEXT_OUTPUT_CHARS,
        typeof rawLength === "number" ? Math.trunc(rawLength) : 4_000
      )
    );
    const end = Math.min(answer.length, start + length);
    return {
      start,
      end,
      total: answer.length,
      content: answer.slice(start, end)
    };
  }

  #childFromRow(row: SqlRow): ChildRecord {
    const answer = row.answer === null ? undefined : rowString(row, "answer");
    const error = row.error === null ? undefined : rowString(row, "error");
    return {
      id: rowString(row, "id"),
      parentScope: rowString(row, "parent_scope"),
      scope: rowString(row, "scope"),
      depth: rowNumber(row, "depth"),
      name: rowString(row, "name"),
      mode: rowString(row, "mode") === "query" ? "query" : "persistent",
      status: rowString(row, "status") as ChildStatus,
      prompt: truncateText(rowString(row, "prompt"), 1_000),
      inputId: rowString(row, "input_id"),
      answer,
      error,
      createdAt: rowNumber(row, "created_at"),
      updatedAt: rowNumber(row, "updated_at")
    };
  }

  #operationFromRow(row: SqlRow): RlmOperationRecord {
    const error = row.error === null ? undefined : rowString(row, "error");
    return {
      id: rowString(row, "id"),
      rootInputId: rowString(row, "root_input_id"),
      kind: rowString(row, "kind") as RlmOperationKind,
      key: rowString(row, "operation_key"),
      argsHash: rowString(row, "args_hash"),
      childId: rowString(row, "child_id"),
      turnInputId: rowString(row, "turn_input_id"),
      sequence: rowNumber(row, "sequence"),
      status: rowString(row, "status") as RlmOperationStatus,
      error,
      createdAt: rowNumber(row, "created_at"),
      updatedAt: rowNumber(row, "updated_at")
    };
  }
}
