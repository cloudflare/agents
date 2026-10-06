/**
 * ThinkHarness's own durable records: which sessions exist, the queue of
 * operations in each, and the tool calls the harness has started. Messages
 * are not here; they live in the Sessions capability, and in-flight model
 * output lives in the Streams capability.
 *
 * Every write is synchronous, so a write can join the transaction a Streams
 * cutover or a Sessions write commits in.
 */
import type { UIMessage } from "ai";
import type { ClientToolSchema } from "../../chat/client-tools";
import type { ToolAnswer } from "../../experimental/channels/harness";

/** What an operation asks the harness to do, as stored. */
export type OperationInput =
  /** Place these user messages, then answer them. */
  | { readonly kind: "messages"; readonly messages: readonly UIMessage[] }
  /** Record a tool result or approval, then continue the turn it unblocks. */
  | {
      readonly kind: "answer";
      readonly answer: ToolAnswer;
      /** Whether to continue the turn once nothing else is awaited. */
      readonly autoContinue: boolean;
    }
  /** Answer a user message again, on a new branch beside earlier answers. */
  | { readonly kind: "regenerate"; readonly messageId?: string }
  /** Continue the latest assistant message. */
  | { readonly kind: "continue" };

/** Where an operation is in its life. */
export type OperationStatus = "queued" | "running" | "done" | "unanswered";

/** One operation row, parsed. */
export type OperationRecord = {
  readonly session: string;
  readonly operationId: string;
  readonly seq: number;
  readonly input: OperationInput;
  readonly status: OperationStatus;
  readonly source: "client" | "server";
  /** The message a new assistant message is a child of. */
  readonly parentId: string | undefined;
  /** This operation's assistant message, once it has one. */
  readonly messageId: string | undefined;
  /** The stream of the model call in progress, if one is. */
  readonly streamId: string | undefined;
  /** Whether the model has to be called before the turn can end. */
  readonly pendingModel: boolean;
  /** Model calls made so far. */
  readonly steps: number;
  /** Interruptions since the turn last made progress. */
  readonly interruptions: number;
  /** Context-overflow retries spent. */
  readonly overflowRetries: number;
  readonly reason: string | undefined;
  readonly text: string | undefined;
  /** Set when the operation must be settled unanswered rather than run on. */
  readonly abandonReason: string | undefined;
  readonly createdAt: number;
};

/** A tool call the harness started, so an eviction mid-call is noticed. */
export type ToolCallRecord = {
  readonly session: string;
  readonly toolCallId: string;
  readonly operationId: string;
  readonly attempts: number;
};

/** A session the harness knows of. */
export type SessionRecord = {
  readonly id: string;
  readonly parent: string | undefined;
  readonly createdAt: number;
};

type OperationRow = {
  session_id: string;
  operation_id: string;
  seq: number;
  input: string;
  status: string;
  source: string;
  parent_id: string | null;
  message_id: string | null;
  stream_id: string | null;
  pending_model: number;
  steps: number;
  interruptions: number;
  overflow_retries: number;
  reason: string | null;
  text: string | null;
  abandon_reason: string | null;
  created_at: number;
};

type SessionRow = {
  id: string;
  parent: string | null;
  client_tools: string | null;
  created_at: number;
};

type ToolCallRow = {
  session_id: string;
  tool_call_id: string;
  operation_id: string;
  attempts: number;
};

/** A change to an operation's progress fields. */
export type OperationUpdate = {
  readonly status?: OperationStatus;
  readonly parentId?: string | null;
  readonly messageId?: string | null;
  readonly streamId?: string | null;
  readonly pendingModel?: boolean;
  readonly steps?: number;
  readonly interruptions?: number;
  readonly overflowRetries?: number;
  readonly reason?: string | null;
  readonly text?: string | null;
  readonly abandonReason?: string | null;
};

const STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "done",
  "unanswered"
]);

function parseStatus(value: string): OperationStatus {
  if (!STATUSES.has(value)) {
    throw new Error(`Unknown ThinkHarness operation status ${value}`);
  }
  // SAFETY: checked against the closed set above.
  return value as OperationStatus;
}

function parseOperation(row: OperationRow): OperationRecord {
  // SAFETY: the input column is only written by `insert`, from an
  // OperationInput serialized with JSON.stringify.
  const input = JSON.parse(row.input) as OperationInput;
  return {
    session: row.session_id,
    operationId: row.operation_id,
    seq: row.seq,
    input,
    status: parseStatus(row.status),
    source: row.source === "client" ? "client" : "server",
    parentId: row.parent_id ?? undefined,
    messageId: row.message_id ?? undefined,
    streamId: row.stream_id ?? undefined,
    pendingModel: row.pending_model === 1,
    steps: row.steps,
    interruptions: row.interruptions,
    overflowRetries: row.overflow_retries,
    reason: row.reason ?? undefined,
    text: row.text ?? undefined,
    abandonReason: row.abandon_reason ?? undefined,
    createdAt: row.created_at
  };
}

/**
 * The harness's own tables, over the object's SQLite: sessions, the
 * operation queue, and started tool calls. Named apart from the shared
 * `agents/harness/store`, which is a different, harness-agnostic store.
 */
export class OperationRecords {
  readonly #sql: SqlStorage;
  #ready = false;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  /** Create the tables. Idempotent. */
  ensureTables(): void {
    if (this.#ready) return;
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS cf_think_harness_sessions (
      id TEXT PRIMARY KEY,
      parent TEXT,
      client_tools TEXT,
      created_at INTEGER NOT NULL
    )`);
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS cf_think_harness_operations (
      session_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      input TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      parent_id TEXT,
      message_id TEXT,
      stream_id TEXT,
      pending_model INTEGER NOT NULL DEFAULT 0,
      steps INTEGER NOT NULL DEFAULT 0,
      interruptions INTEGER NOT NULL DEFAULT 0,
      overflow_retries INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      text TEXT,
      abandon_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, operation_id)
    )`);
    this.#sql.exec(`CREATE INDEX IF NOT EXISTS cf_think_harness_operations_open
      ON cf_think_harness_operations (session_id, status, seq)`);
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS cf_think_harness_tool_calls (
      session_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      PRIMARY KEY (session_id, tool_call_id)
    )`);
    this.#ready = true;
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  /** Record a session, unless it exists. Returns whether it was new. */
  ensureSession(id: string, parent?: string): boolean {
    const written = this.#sql.exec(
      `INSERT OR IGNORE INTO cf_think_harness_sessions (id, parent, created_at)
       VALUES (?, ?, ?)`,
      id,
      parent ?? null,
      Date.now()
    ).rowsWritten;
    return written > 0;
  }

  /** Every session, oldest first. */
  sessions(): SessionRecord[] {
    return this.#sql
      .exec<SessionRow>(
        `SELECT id, parent, client_tools, created_at
         FROM cf_think_harness_sessions ORDER BY created_at, id`
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        parent: row.parent ?? undefined,
        createdAt: row.created_at
      }));
  }

  /** The client tools a session's client last declared. */
  clientTools(session: string): ClientToolSchema[] {
    const row = this.#sql
      .exec<Pick<SessionRow, "client_tools">>(
        `SELECT client_tools FROM cf_think_harness_sessions WHERE id = ?`,
        session
      )
      .toArray()[0];
    if (!row?.client_tools) return [];
    // SAFETY: written only by setClientTools from ClientToolSchema[].
    return JSON.parse(row.client_tools) as ClientToolSchema[];
  }

  /** Replace the client tools a session's client declared. */
  setClientTools(session: string, tools: readonly ClientToolSchema[]): void {
    this.#sql.exec(
      `UPDATE cf_think_harness_sessions SET client_tools = ? WHERE id = ?`,
      JSON.stringify(tools),
      session
    );
  }

  // ── Operations ───────────────────────────────────────────────────────────

  /** Insert a queued operation. Returns false when the id already exists. */
  insert(
    session: string,
    operationId: string,
    input: OperationInput,
    source: "client" | "server"
  ): boolean {
    const now = Date.now();
    return (
      this.#sql.exec(
        `INSERT OR IGNORE INTO cf_think_harness_operations
           (session_id, operation_id, seq, input, status, source, created_at, updated_at)
         VALUES (?, ?,
           (SELECT COALESCE(MAX(seq), 0) + 1 FROM cf_think_harness_operations),
           ?, 'queued', ?, ?, ?)`,
        session,
        operationId,
        JSON.stringify(input),
        source,
        now,
        now
      ).rowsWritten > 0
    );
  }

  /** One operation. */
  get(session: string, operationId: string): OperationRecord | undefined {
    const row = this.#sql
      .exec<OperationRow>(
        `SELECT * FROM cf_think_harness_operations
         WHERE session_id = ? AND operation_id = ?`,
        session,
        operationId
      )
      .toArray()[0];
    return row ? parseOperation(row) : undefined;
  }

  /** Unsettled operations, oldest first; every session when none is given. */
  open(session?: string): OperationRecord[] {
    const rows =
      session === undefined
        ? this.#sql.exec<OperationRow>(
            `SELECT * FROM cf_think_harness_operations
             WHERE status IN ('queued', 'running') ORDER BY seq`
          )
        : this.#sql.exec<OperationRow>(
            `SELECT * FROM cf_think_harness_operations
             WHERE session_id = ? AND status IN ('queued', 'running')
             ORDER BY seq`,
            session
          );
    return rows.toArray().map(parseOperation);
  }

  /** Apply a change to an operation's fields. */
  update(session: string, operationId: string, change: OperationUpdate): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    const set = (column: string, value: string | number | null) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (change.status !== undefined) set("status", change.status);
    if (change.parentId !== undefined) set("parent_id", change.parentId);
    if (change.messageId !== undefined) set("message_id", change.messageId);
    if (change.streamId !== undefined) set("stream_id", change.streamId);
    if (change.pendingModel !== undefined) {
      set("pending_model", change.pendingModel ? 1 : 0);
    }
    if (change.steps !== undefined) set("steps", change.steps);
    if (change.interruptions !== undefined) {
      set("interruptions", change.interruptions);
    }
    if (change.overflowRetries !== undefined) {
      set("overflow_retries", change.overflowRetries);
    }
    if (change.reason !== undefined) set("reason", change.reason);
    if (change.text !== undefined) set("text", change.text);
    if (change.abandonReason !== undefined) {
      set("abandon_reason", change.abandonReason);
    }
    set("updated_at", Date.now());
    this.#sql.exec(
      `UPDATE cf_think_harness_operations SET ${sets.join(", ")}
       WHERE session_id = ? AND operation_id = ?`,
      ...values,
      session,
      operationId
    );
  }

  /** Forget every settled operation in a session, for a reset. */
  deleteSettled(session: string): void {
    this.#sql.exec(
      `DELETE FROM cf_think_harness_operations
       WHERE session_id = ? AND status IN ('done', 'unanswered')`,
      session
    );
    this.#sql.exec(
      `DELETE FROM cf_think_harness_tool_calls WHERE session_id = ?`,
      session
    );
  }

  // ── Tool calls ───────────────────────────────────────────────────────────

  /** The record of a started tool call, if it was started. */
  toolCall(session: string, toolCallId: string): ToolCallRecord | undefined {
    const row = this.#sql
      .exec<ToolCallRow>(
        `SELECT * FROM cf_think_harness_tool_calls
         WHERE session_id = ? AND tool_call_id = ?`,
        session,
        toolCallId
      )
      .toArray()[0];
    return row
      ? {
          session: row.session_id,
          toolCallId: row.tool_call_id,
          operationId: row.operation_id,
          attempts: row.attempts
        }
      : undefined;
  }

  /** Record that a tool call is starting. Returns the attempt number. */
  startToolCall(
    session: string,
    toolCallId: string,
    operationId: string
  ): number {
    const attempts = (this.toolCall(session, toolCallId)?.attempts ?? 0) + 1;
    this.#sql.exec(
      `INSERT OR REPLACE INTO cf_think_harness_tool_calls
         (session_id, tool_call_id, operation_id, attempts)
       VALUES (?, ?, ?, ?)`,
      session,
      toolCallId,
      operationId,
      attempts
    );
    return attempts;
  }

  /** Forget a tool call once its result is in the transcript. */
  finishToolCall(session: string, toolCallId: string): void {
    this.#sql.exec(
      `DELETE FROM cf_think_harness_tool_calls
       WHERE session_id = ? AND tool_call_id = ?`,
      session,
      toolCallId
    );
  }
}
