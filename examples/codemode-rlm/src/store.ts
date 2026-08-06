import {
  INPUT_CHUNK_CHARS,
  MAX_ANSWER_CHARS,
  MAX_CONTEXT_OUTPUT_CHARS,
  MAX_INPUT_CHARS,
  MAX_KERNEL_KEYS,
  MAX_KERNEL_VALUE_CHARS,
  applyHarnessUpdate,
  buildHarnessOverview,
  emptyHarnessState,
  inputSource,
  isRecord,
  requireString,
  truncateText,
  type HarnessState,
  type HarnessUpdate,
  type InputSource
} from "./core";

export type InputKind = "think" | "refine" | "child";

export type InputMeta = {
  id: string;
  scope: string;
  requestId?: string;
  kind: InputKind;
  taskChars: number;
  materialChars: number;
  createdAt: number;
};

export type AnswerRecord = {
  inputId: string;
  content: string;
  executionId: string;
  verified: boolean;
  createdAt: number;
};

export type HistoryMessage = {
  id: number;
  scope: string;
  role: "user" | "assistant";
  content: string;
  metadata: Record<string, unknown>;
  createdAt: number;
};

export type RlmOperationKind = "query" | "spawn" | "followup";

export type RlmOperation = {
  id: string;
  rootInputId: string;
  kind: RlmOperationKind;
  key: string;
  argsHash: string;
  childId: string;
  turnInputId: string;
  createdAt: number;
};

type SqlRow = Record<string, ArrayBuffer | string | number | null>;
const STORE_SCHEMA_VERSION = 1;

function rowString(row: SqlRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : String(value ?? "");
}

function rowNumber(row: SqlRow, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : Number(value ?? 0);
}

function safeJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("value must not be undefined");
    return encoded;
  } catch (error) {
    throw new Error(
      `value must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseHarness(value: unknown): HarnessState | undefined {
  const parsed = parseJson(value);
  if (
    !isRecord(parsed) ||
    parsed.schema !== 2 ||
    !Array.isArray(parsed.entries)
  ) {
    return undefined;
  }
  return parsed as HarnessState;
}

export class RlmStore {
  readonly #storage: DurableObjectStorage;
  readonly #sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    this.#sql = storage.sql;
    this.#initialize();
  }

  #initialize(): void {
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS rlm_store_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL
      )
    `);
    const version = rowNumber(
      this.#first(
        "SELECT schema_version FROM rlm_store_meta WHERE singleton = 1"
      ) ?? {},
      "schema_version"
    );
    if (version !== STORE_SCHEMA_VERSION) {
      // This experimental example deliberately resets only its own tables when
      // the example schema changes. Production applications should migrate.
      this.#storage.transactionSync(() => {
        this.#sql.exec(`
          DROP TABLE IF EXISTS answers;
          DROP TABLE IF EXISTS child_completions;
          DROP TABLE IF EXISTS children;
          DROP TABLE IF EXISTS execution_scopes;
          DROP TABLE IF EXISTS harness_mutations;
          DROP TABLE IF EXISTS harness_revisions;
          DROP TABLE IF EXISTS harness_state;
          DROP TABLE IF EXISTS harness_turn_writes;
          DROP TABLE IF EXISTS input_chunks;
          DROP TABLE IF EXISTS inputs;
          DROP TABLE IF EXISTS kernel_state;
          DROP TABLE IF EXISTS messages;
          DROP TABLE IF EXISTS rlm_budgets;
          DROP TABLE IF EXISTS rlm_operation_executions;
          DROP TABLE IF EXISTS rlm_operations;
          DROP TABLE IF EXISTS root_requests;
          DROP TABLE IF EXISTS snippet_promotions;
          DROP TABLE IF EXISTS turn_transcript_messages;
        `);
        this.#sql.exec(
          "INSERT OR REPLACE INTO rlm_store_meta (singleton, schema_version) VALUES (1, ?)",
          STORE_SCHEMA_VERSION
        );
      });
    }

    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS inputs (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        request_id TEXT,
        kind TEXT NOT NULL,
        task_chars INTEGER NOT NULL,
        material_chars INTEGER NOT NULL,
        activated_at INTEGER,
        activation_sequence INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inputs_scope_activation
        ON inputs (scope, activation_sequence DESC);
      CREATE TABLE IF NOT EXISTS input_chunks (
        input_id TEXT NOT NULL,
        source TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (input_id, source, chunk_index)
      );
      CREATE TABLE IF NOT EXISTS kernel_state (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE IF NOT EXISTS answers (
        input_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        content TEXT NOT NULL,
        verified INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (input_id, execution_id)
      );
      CREATE TABLE IF NOT EXISTS rlm_operations (
        id TEXT PRIMARY KEY,
        root_input_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        operation_key TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        child_id TEXT NOT NULL,
        turn_input_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS rlm_operations_root
        ON rlm_operations (root_input_id, created_at);
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
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS harness_mutations (
        input_id TEXT PRIMARY KEY,
        request TEXT NOT NULL,
        state TEXT NOT NULL
      );
    `);

    this.#sql.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS inputs_request_id ON inputs (request_id) WHERE request_id IS NOT NULL"
    );

    const existing = this.#first(
      "SELECT state FROM harness_state WHERE singleton = 1"
    );
    if (!existing) {
      const initial = emptyHarnessState();
      const now = Date.now();
      this.#storage.transactionSync(() => {
        this.#sql.exec(
          "INSERT INTO harness_state (singleton, revision, state, updated_at) VALUES (1, 0, ?, ?)",
          JSON.stringify(initial),
          now
        );
        this.#sql.exec(
          "INSERT INTO harness_revisions (revision, state, reason, evidence, created_at) VALUES (0, ?, 'initial harness', '', ?)",
          JSON.stringify(initial),
          now
        );
      });
    } else if (!parseHarness(existing.state)) {
      throw new Error("unsupported continual harness schema");
    }
  }

  #first(query: string, ...bindings: unknown[]): SqlRow | undefined {
    return this.#sql.exec(query, ...bindings).toArray()[0];
  }

  #inputMeta(row: SqlRow): InputMeta {
    const requestId =
      row.request_id === null ? undefined : rowString(row, "request_id");
    const rawKind = rowString(row, "kind");
    const kind: InputKind =
      rawKind === "think" || rawKind === "refine" ? rawKind : "child";
    return {
      id: rowString(row, "id"),
      scope: rowString(row, "scope"),
      requestId,
      kind,
      taskChars: rowNumber(row, "task_chars"),
      materialChars: rowNumber(row, "material_chars"),
      createdAt: rowNumber(row, "created_at")
    };
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

  #inputMatches(id: string, source: InputSource, value: string): boolean {
    const chunks = this.#sql
      .exec(
        "SELECT chunk_index, content FROM input_chunks WHERE input_id = ? AND source = ? ORDER BY chunk_index",
        id,
        source
      )
      .toArray();
    const expectedChunks =
      value.length === 0 ? 0 : Math.ceil(value.length / INPUT_CHUNK_CHARS);
    if (chunks.length !== expectedChunks) return false;
    return chunks.every((row) => {
      const index = rowNumber(row, "chunk_index");
      return (
        rowString(row, "content") ===
        value.slice(index * INPUT_CHUNK_CHARS, (index + 1) * INPUT_CHUNK_CHARS)
      );
    });
  }

  putInput(options: {
    id: string;
    scope: string;
    requestId?: string;
    kind: InputKind;
    task: string;
    material: string;
  }): InputMeta {
    const id = requireString(options.id, "inputId", { min: 1, max: 120 });
    const scope = requireString(options.scope, "scope", { min: 1, max: 180 });
    const requestId =
      options.requestId === undefined
        ? undefined
        : requireString(options.requestId, "requestId", { min: 1, max: 120 });
    const task = requireString(options.task, "task", {
      min: 1,
      max: MAX_INPUT_CHARS
    });
    const material = requireString(options.material, "material", {
      max: MAX_INPUT_CHARS
    });
    if (task.length + material.length > MAX_INPUT_CHARS) {
      throw new Error(
        `task and material together may contain at most ${MAX_INPUT_CHARS} characters`
      );
    }
    const existing = this.inputMetaOrUndefined(id);
    if (existing) {
      if (
        existing.scope !== scope ||
        existing.requestId !== requestId ||
        existing.kind !== options.kind ||
        existing.taskChars !== task.length ||
        existing.materialChars !== material.length ||
        !this.#inputMatches(id, "task", task) ||
        !this.#inputMatches(id, "material", material)
      ) {
        throw new Error(`input id ${id} was reused with different data`);
      }
      return existing;
    }

    const createdAt = Date.now();
    this.#storage.transactionSync(() => {
      if (requestId) {
        const claimed = this.inputForRequest(requestId);
        if (claimed)
          throw new Error(
            `request id ${requestId} was reused with different arguments`
          );
      }
      this.#sql.exec(
        "INSERT INTO inputs (id, scope, request_id, kind, task_chars, material_chars, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        scope,
        requestId ?? null,
        options.kind,
        task.length,
        material.length,
        createdAt
      );
      for (const [source, value] of [
        ["task", task],
        ["material", material]
      ] as const) {
        for (
          let offset = 0, index = 0;
          offset < value.length;
          offset += INPUT_CHUNK_CHARS, index += 1
        ) {
          this.#sql.exec(
            "INSERT INTO input_chunks (input_id, source, chunk_index, content) VALUES (?, ?, ?, ?)",
            id,
            source,
            index,
            value.slice(offset, offset + INPUT_CHUNK_CHARS)
          );
        }
      }
    });
    return this.inputMeta(id);
  }

  inputMeta(id: string): InputMeta {
    const row = this.#first("SELECT * FROM inputs WHERE id = ?", id);
    if (!row) throw new Error(`input ${id} was not found`);
    return this.#inputMeta(row);
  }

  inputMetaOrUndefined(id: string): InputMeta | undefined {
    const row = this.#first("SELECT * FROM inputs WHERE id = ?", id);
    return row ? this.#inputMeta(row) : undefined;
  }

  inputForRequest(requestId: string): InputMeta | undefined {
    const row = this.#first(
      "SELECT * FROM inputs WHERE request_id = ?",
      requestId
    );
    return row ? this.#inputMeta(row) : undefined;
  }

  latestInput(scope: string): InputMeta | undefined {
    const row = this.#first(
      "SELECT * FROM inputs WHERE scope = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      scope
    );
    return row ? this.#inputMeta(row) : undefined;
  }

  inputPayload(id: string): { task: string; material: string } {
    this.inputMeta(id);
    return {
      task: this.#inputContent(id, "task"),
      material: this.#inputContent(id, "material")
    };
  }

  activateInput(id: string, scope: string): void {
    const meta = this.inputMeta(id);
    if (meta.scope !== scope)
      throw new Error(`input ${id} does not belong to ${scope}`);
    this.#storage.transactionSync(() => {
      const row = this.#first(
        "SELECT activated_at FROM inputs WHERE id = ?",
        id
      );
      if (row?.activated_at !== null) return;
      const next = rowNumber(
        this.#first(
          "SELECT COALESCE(MAX(activation_sequence), 0) + 1 AS value FROM inputs WHERE scope = ?",
          scope
        )!,
        "value"
      );
      this.#sql.exec(
        "UPDATE inputs SET activated_at = ?, activation_sequence = ? WHERE id = ? AND activated_at IS NULL",
        Date.now(),
        next,
        id
      );
    });
  }

  #activationSequence(id: string): number | undefined {
    const row = this.#first(
      "SELECT activation_sequence FROM inputs WHERE id = ?",
      id
    );
    if (!row || row.activation_sequence === null) return undefined;
    return rowNumber(row, "activation_sequence");
  }

  inputVisibleFrom(scope: string, currentInputId: string, id: string): boolean {
    const current = this.#activationSequence(currentInputId);
    if (current === undefined) return id === currentInputId;
    const row = this.#first(
      "SELECT 1 AS found FROM inputs WHERE id = ? AND scope = ? AND activation_sequence IS NOT NULL AND activation_sequence <= ?",
      id,
      scope,
      current
    );
    return Boolean(row);
  }

  inputs(scope: string, currentInputId: string, limit = 20): InputMeta[] {
    const current = this.#activationSequence(currentInputId);
    if (current === undefined) return [this.inputMeta(currentInputId)];
    return this.#sql
      .exec(
        "SELECT * FROM inputs WHERE scope = ? AND activation_sequence IS NOT NULL AND activation_sequence <= ? ORDER BY activation_sequence DESC LIMIT ?",
        scope,
        current,
        limit
      )
      .toArray()
      .map((row) => this.#inputMeta(row));
  }

  inputSlice(
    id: string,
    rawSource: unknown,
    rawStart: unknown,
    rawLength: unknown
  ): {
    start: number;
    end: number;
    total: number;
    content: string;
  } {
    const source = inputSource(rawSource);
    const meta = this.inputMeta(id);
    const total = source === "task" ? meta.taskChars : meta.materialChars;
    const start = Math.max(0, Math.min(total, Number(rawStart) || 0));
    const length = Math.max(
      1,
      Math.min(MAX_CONTEXT_OUTPUT_CHARS, Number(rawLength) || 4_000)
    );
    const end = Math.min(total, start + length);
    if (start === end) return { start, end, total, content: "" };
    const firstChunk = Math.floor(start / INPUT_CHUNK_CHARS);
    const lastChunk = Math.floor((end - 1) / INPUT_CHUNK_CHARS);
    const content = this.#sql
      .exec(
        "SELECT content FROM input_chunks WHERE input_id = ? AND source = ? AND chunk_index BETWEEN ? AND ? ORDER BY chunk_index",
        id,
        source,
        firstChunk,
        lastChunk
      )
      .toArray()
      .map((row) => rowString(row, "content"))
      .join("")
      .slice(
        start - firstChunk * INPUT_CHUNK_CHARS,
        end - firstChunk * INPUT_CHUNK_CHARS
      );
    return { start, end, total, content };
  }

  searchInput(
    id: string,
    rawSource: unknown,
    rawQuery: unknown,
    rawLimit: unknown
  ): Array<{
    offset: number;
    preview: string;
  }> {
    const source = inputSource(rawSource);
    const query = requireString(rawQuery, "query", { min: 2, max: 500 });
    const limit = Math.max(1, Math.min(20, Number(rawLimit) || 8));
    const needle = query.toLocaleLowerCase();
    const matches: Array<{ offset: number; preview: string }> = [];
    const chunks = this.#sql
      .exec(
        "SELECT chunk_index, content FROM input_chunks WHERE input_id = ? AND source = ? ORDER BY chunk_index",
        id,
        source
      )
      .toArray();
    let carry = "";
    for (const row of chunks) {
      const chunk = rowString(row, "content");
      const chunkIndex = rowNumber(row, "chunk_index");
      const window = carry + chunk;
      const haystack = window.toLocaleLowerCase();
      let cursor = 0;
      while (matches.length < limit) {
        const index = haystack.indexOf(needle, cursor);
        if (index < 0) break;
        const absolute = chunkIndex * INPUT_CHUNK_CHARS - carry.length + index;
        // A boundary-spanning match is visible in both adjacent windows; keep
        // only the first occurrence at a given absolute offset.
        if (absolute > (matches.at(-1)?.offset ?? -1)) {
          matches.push({
            offset: absolute,
            preview: window.slice(
              Math.max(0, index - 120),
              Math.min(window.length, index + query.length + 240)
            )
          });
        }
        cursor = index + Math.max(1, needle.length);
      }
      if (matches.length >= limit) break;
      carry = window.slice(-Math.min(query.length - 1 + 120, 620));
    }
    return matches;
  }

  history(scope: string, limit = 50): HistoryMessage[] {
    const rows = this.#sql
      .exec(
        `SELECT i.*, i.activation_sequence, a.content AS answer_content,
                a.verified AS answer_verified, a.created_at AS answer_created_at
         FROM inputs i
         LEFT JOIN answers a ON a.input_id = i.id AND a.verified = 1
         WHERE i.scope = ? AND i.activation_sequence IS NOT NULL
         ORDER BY i.activation_sequence DESC LIMIT ?`,
        scope,
        Math.max(1, limit)
      )
      .toArray()
      .reverse();
    const messages: HistoryMessage[] = [];
    for (const row of rows) {
      const meta = this.#inputMeta(row);
      const sequence = rowNumber(row, "activation_sequence");
      messages.push({
        id: sequence * 2,
        scope,
        role: "user",
        content: this.inputSlice(meta.id, "task", 0, MAX_CONTEXT_OUTPUT_CHARS)
          .content,
        metadata: {
          inputId: meta.id,
          requestId: meta.requestId,
          kind: meta.kind
        },
        createdAt: meta.createdAt
      });
      if (
        rowNumber(row, "answer_verified") === 1 &&
        typeof row.answer_content === "string"
      ) {
        messages.push({
          id: sequence * 2 + 1,
          scope,
          role: "assistant",
          content: row.answer_content,
          metadata: {
            inputId: meta.id,
            requestId: meta.requestId,
            kind: meta.kind
          },
          createdAt: rowNumber(row, "answer_created_at")
        });
      }
    }
    // The API has always returned newest first; the chat client reverses once
    // for chronological rendering.
    return messages.slice(-limit).reverse();
  }

  setKernel(scope: string, rawKey: unknown, value: unknown): unknown {
    const key = requireString(rawKey, "key", { min: 1, max: 120 });
    const encoded = safeJson(value);
    if (encoded.length > MAX_KERNEL_VALUE_CHARS) {
      throw new Error(
        `kernel value may contain at most ${MAX_KERNEL_VALUE_CHARS} serialized characters`
      );
    }
    const existing = this.#first(
      "SELECT 1 AS found FROM kernel_state WHERE scope = ? AND key = ?",
      scope,
      key
    );
    if (
      !existing &&
      rowNumber(
        this.#first(
          "SELECT COUNT(*) AS count FROM kernel_state WHERE scope = ?",
          scope
        )!,
        "count"
      ) >= MAX_KERNEL_KEYS
    ) {
      throw new Error(
        `kernel state is limited to ${MAX_KERNEL_KEYS} keys per agent scope`
      );
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

  getKernel(scope: string, rawKey: unknown): unknown {
    const key = requireString(rawKey, "key", { min: 1, max: 120 });
    return parseJson(
      this.#first(
        "SELECT value FROM kernel_state WHERE scope = ? AND key = ?",
        scope,
        key
      )?.value
    );
  }

  listKernel(
    scope: string
  ): Array<{ key: string; chars: number; updatedAt: number }> {
    return this.#sql
      .exec(
        "SELECT key, length(value) AS chars, updated_at FROM kernel_state WHERE scope = ? ORDER BY key",
        scope
      )
      .toArray()
      .map((row) => ({
        key: rowString(row, "key"),
        chars: rowNumber(row, "chars"),
        updatedAt: rowNumber(row, "updated_at")
      }));
  }

  deleteKernel(scope: string, rawKey: unknown): void {
    const key = requireString(rawKey, "key", { min: 1, max: 120 });
    this.#sql.exec(
      "DELETE FROM kernel_state WHERE scope = ? AND key = ?",
      scope,
      key
    );
  }

  stageAnswer(
    scope: string,
    inputId: string,
    rawContent: unknown,
    executionId?: string
  ): string {
    const content = requireString(rawContent, "content", {
      min: 1,
      max: MAX_ANSWER_CHARS
    });
    if (!executionId)
      throw new Error("kernel.finish requires a Code Mode execution id");
    const existing = this.answerRecord(inputId);
    if (existing) {
      if (existing.executionId === executionId && existing.content === content)
        return content;
      throw new Error("this input already has a verified answer");
    }
    this.#sql.exec(
      "INSERT INTO answers (input_id, scope, execution_id, content, verified, created_at) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(input_id, execution_id) DO UPDATE SET scope = excluded.scope, content = excluded.content, verified = 0, created_at = excluded.created_at",
      inputId,
      scope,
      executionId,
      content,
      Date.now()
    );
    return content;
  }

  verifyAnswer(inputId: string, executionId: string): boolean {
    return this.#storage.transactionSync(() => {
      const existing = this.answerRecord(inputId);
      if (existing) return existing.executionId === executionId;
      this.#sql.exec(
        "UPDATE answers SET verified = 1 WHERE input_id = ? AND execution_id = ? AND verified = 0",
        inputId,
        executionId
      );
      const verified = this.answerRecord(inputId);
      if (verified?.executionId === executionId) {
        this.#sql.exec(
          "DELETE FROM answers WHERE input_id = ? AND execution_id <> ? AND verified = 0",
          inputId,
          executionId
        );
        return true;
      }
      return false;
    });
  }

  discardAnswer(inputId: string, executionId: string): void {
    this.#sql.exec(
      "DELETE FROM answers WHERE input_id = ? AND execution_id = ?",
      inputId,
      executionId
    );
  }

  answerRecord(inputId: string): AnswerRecord | undefined {
    const row = this.#first(
      "SELECT * FROM answers WHERE input_id = ? AND verified = 1 ORDER BY created_at LIMIT 1",
      inputId
    );
    if (!row) return undefined;
    return {
      inputId,
      content: rowString(row, "content"),
      executionId: rowString(row, "execution_id"),
      verified: rowNumber(row, "verified") === 1,
      createdAt: rowNumber(row, "created_at")
    };
  }

  claimOperation(options: {
    id: string;
    rootInputId: string;
    kind: RlmOperationKind;
    key: string;
    argsHash: string;
    childId: string;
    turnInputId: string;
    maximum: number;
  }): { created: boolean; operation: RlmOperation } {
    return this.#storage.transactionSync(() => {
      const existing = this.operation(options.id);
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
        return { created: false, operation: existing };
      }
      if (this.rlmCalls(options.rootInputId) >= options.maximum) {
        throw new Error(
          `this turn may create at most ${options.maximum} recursive operations`
        );
      }
      const createdAt = Date.now();
      this.#sql.exec(
        "INSERT INTO rlm_operations (id, root_input_id, kind, operation_key, args_hash, child_id, turn_input_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        options.id,
        options.rootInputId,
        options.kind,
        options.key,
        options.argsHash,
        options.childId,
        options.turnInputId,
        createdAt
      );
      return { created: true, operation: { ...options, createdAt } };
    });
  }

  operation(id: string): RlmOperation | undefined {
    const row = this.#first("SELECT * FROM rlm_operations WHERE id = ?", id);
    if (!row) return undefined;
    const kind = rowString(row, "kind") as RlmOperationKind;
    return {
      id: rowString(row, "id"),
      rootInputId: rowString(row, "root_input_id"),
      kind,
      key: rowString(row, "operation_key"),
      argsHash: rowString(row, "args_hash"),
      childId: rowString(row, "child_id"),
      turnInputId: rowString(row, "turn_input_id"),
      createdAt: rowNumber(row, "created_at")
    };
  }

  rlmCalls(rootInputId: string): number {
    return rowNumber(
      this.#first(
        "SELECT COUNT(*) AS count FROM rlm_operations WHERE root_input_id = ?",
        rootInputId
      )!,
      "count"
    );
  }

  harness(): HarnessState {
    const state = parseHarness(
      this.#first("SELECT state FROM harness_state WHERE singleton = 1")?.state
    );
    return state ?? emptyHarnessState();
  }

  harnessOverview(): string {
    return buildHarnessOverview(this.harness());
  }

  #harnessMutation(inputId: string, request: string): HarnessState | undefined {
    const row = this.#first(
      "SELECT request, state FROM harness_mutations WHERE input_id = ?",
      inputId
    );
    if (!row) return undefined;
    if (rowString(row, "request") !== request) {
      throw new Error(
        `refinement input ${inputId} already made a different harness mutation`
      );
    }
    const state = parseHarness(row.state);
    if (!state) throw new Error("stored harness mutation is invalid");
    return state;
  }

  updateHarness(inputId: string, update: HarnessUpdate): HarnessState {
    const id = requireString(inputId, "inputId", { min: 1, max: 120 });
    const request = safeJson({ kind: "update", ...update });
    return this.#storage.transactionSync(() => {
      const replay = this.#harnessMutation(id, request);
      if (replay) return replay;
      const current = this.harness();
      const next = applyHarnessUpdate(current, update);
      const now = Date.now();
      const encoded = JSON.stringify(next);
      this.#sql.exec(
        "UPDATE harness_state SET revision = ?, state = ?, updated_at = ? WHERE singleton = 1",
        next.revision,
        encoded,
        now
      );
      this.#sql.exec(
        "INSERT INTO harness_revisions (revision, state, reason, evidence, created_at) VALUES (?, ?, ?, ?, ?)",
        next.revision,
        encoded,
        update.reason,
        update.evidence,
        now
      );
      this.#sql.exec(
        "INSERT INTO harness_mutations (input_id, request, state) VALUES (?, ?, ?)",
        id,
        request,
        encoded
      );
      this.#pruneHarnessRevisions(next.revision);
      return next;
    });
  }

  rollbackHarness(
    inputId: string,
    rawExpectedRevision: unknown,
    rawTargetRevision: unknown,
    rawEvidence: unknown
  ): HarnessState {
    const id = requireString(inputId, "inputId", { min: 1, max: 120 });
    const expectedRevision = Number(rawExpectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("expectedRevision must be a non-negative integer");
    }
    const targetRevision = Number(rawTargetRevision);
    if (!Number.isInteger(targetRevision) || targetRevision < 0) {
      throw new Error("targetRevision must be a non-negative integer");
    }
    const evidence = requireString(rawEvidence, "evidence", {
      min: 1,
      max: 8_000
    });
    const request = safeJson({
      kind: "rollback",
      expectedRevision,
      targetRevision,
      evidence
    });
    return this.#storage.transactionSync(() => {
      const replay = this.#harnessMutation(id, request);
      if (replay) return replay;
      const current = this.harness();
      if (current.revision !== expectedRevision) {
        throw new Error(
          `harness revision conflict: expected ${expectedRevision}, current is ${current.revision}`
        );
      }
      const target = parseHarness(
        this.#first(
          "SELECT state FROM harness_revisions WHERE revision = ?",
          targetRevision
        )?.state
      );
      if (!target)
        throw new Error(`harness revision ${targetRevision} was not found`);
      const now = Date.now();
      const next: HarnessState = {
        schema: 2,
        revision: current.revision + 1,
        entries: target.entries,
        lastChange: {
          reason: `rollback to revision ${targetRevision}`,
          evidence,
          createdAt: now
        }
      };
      const encoded = JSON.stringify(next);
      this.#sql.exec(
        "UPDATE harness_state SET revision = ?, state = ?, updated_at = ? WHERE singleton = 1",
        next.revision,
        encoded,
        now
      );
      this.#sql.exec(
        "INSERT INTO harness_revisions (revision, state, reason, evidence, created_at) VALUES (?, ?, ?, ?, ?)",
        next.revision,
        encoded,
        next.lastChange!.reason,
        evidence,
        now
      );
      this.#sql.exec(
        "INSERT INTO harness_mutations (input_id, request, state) VALUES (?, ?, ?)",
        id,
        request,
        encoded
      );
      this.#pruneHarnessRevisions(next.revision);
      return next;
    });
  }

  #pruneHarnessRevisions(current: number): void {
    this.#sql.exec(
      "DELETE FROM harness_revisions WHERE revision > 0 AND revision <= ?",
      current - 100
    );
  }

  harnessRevisions(limit = 20): Array<{
    revision: number;
    reason: string;
    evidence: string;
    createdAt: number;
  }> {
    return this.#sql
      .exec(
        "SELECT revision, reason, evidence, created_at FROM harness_revisions ORDER BY revision DESC LIMIT ?",
        limit
      )
      .toArray()
      .map((row) => ({
        revision: rowNumber(row, "revision"),
        reason: rowString(row, "reason"),
        evidence: truncateText(
          rowString(row, "evidence"),
          MAX_CONTEXT_OUTPUT_CHARS
        ),
        createdAt: rowNumber(row, "created_at")
      }));
  }
}
