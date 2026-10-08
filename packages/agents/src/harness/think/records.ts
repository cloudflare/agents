/**
 * ThinkHarness's own durable records: which sessions exist, the queue of
 * operations in each, and the tool calls the harness has started. Messages
 * are not here; they live in the Sessions capability, and in-flight model
 * output lives in the Streams capability.
 *
 * The records are kept in the shared, harness-agnostic store
 * (`agents/harness/store`), under the `cf_think_harness_store_` prefix. This
 * module is the translation between the harness's records and the store's
 * opaque JSON: an operation's progress is its `meta`, a done operation's
 * text is its `result`, and a session's declared client tools and started
 * tool calls are its `state`.
 *
 * Every write is synchronous, so a write can join the transaction a Streams
 * cutover or a Sessions write commits in.
 */
import type { UIMessage } from "ai";
import type { ClientToolSchema } from "../../chat/client-tools";
import type { ToolAnswer } from "../../experimental/channels/harness";
import {
  openHarnessStore,
  type HarnessStore,
  type JsonValue,
  type OperationRecord as StoredOperation
} from "../store/store";

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

/** One operation, parsed. */
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
  /** Why an `unanswered` operation ended. */
  readonly reason: string | undefined;
  /** A `done` operation's answer. */
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

/**
 * A change to an operation's progress. A field left out is unchanged;
 * `null` clears it.
 */
export type OperationProgress = {
  readonly parentId?: string | null;
  readonly messageId?: string | null;
  readonly streamId?: string | null;
  readonly pendingModel?: boolean;
  readonly steps?: number;
  readonly interruptions?: number;
  readonly overflowRetries?: number;
  readonly abandonReason?: string | null;
};

/** How an operation ended. */
export type OperationSettlement =
  | { readonly status: "done"; readonly text: string }
  | { readonly status: "unanswered"; readonly reason: string };

/** The shared store's table prefix for ThinkHarness's records. */
const STORE_PREFIX = "cf_think_harness_store_";

/** The tables ThinkHarness kept its records in before the shared store. */
const LEGACY_SESSIONS = "cf_think_harness_sessions";
const LEGACY_OPERATIONS = "cf_think_harness_operations";
const LEGACY_TOOL_CALLS = "cf_think_harness_tool_calls";

const OPEN = ["queued", "running"] as const;

/** An operation's progress, as kept in the store's `meta`. */
type OperationMeta = {
  readonly source: "client" | "server";
  readonly parentId: string | null;
  readonly messageId: string | null;
  readonly streamId: string | null;
  readonly pendingModel: boolean;
  readonly steps: number;
  readonly interruptions: number;
  readonly overflowRetries: number;
  readonly abandonReason: string | null;
};

/** A started tool call, as kept in its session's state. */
type StartedToolCall = {
  readonly operationId: string;
  readonly attempts: number;
};

/** A session's harness-owned state, as kept in the store. */
type SessionState = {
  readonly clientTools: readonly ClientToolSchema[];
  readonly toolCalls: Readonly<Record<string, StartedToolCall>>;
};

const EMPTY_STATE: SessionState = { clientTools: [], toolCalls: {} };

function isRecord(
  value: JsonValue | undefined
): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function count(value: JsonValue | undefined): number {
  return typeof value === "number" ? value : 0;
}

function parseMeta(value: JsonValue): OperationMeta {
  const fields = isRecord(value) ? value : {};
  return {
    source: fields.source === "client" ? "client" : "server",
    parentId: stringOrNull(fields.parentId),
    messageId: stringOrNull(fields.messageId),
    streamId: stringOrNull(fields.streamId),
    pendingModel: fields.pendingModel === true,
    steps: count(fields.steps),
    interruptions: count(fields.interruptions),
    overflowRetries: count(fields.overflowRetries),
    abandonReason: stringOrNull(fields.abandonReason)
  };
}

function newMeta(source: "client" | "server"): OperationMeta {
  return {
    source,
    parentId: null,
    messageId: null,
    streamId: null,
    pendingModel: false,
    steps: 0,
    interruptions: 0,
    overflowRetries: 0,
    abandonReason: null
  };
}

function metaJson(meta: OperationMeta): JsonValue {
  return { ...meta };
}

function withProgress(
  meta: OperationMeta,
  change: OperationProgress
): OperationMeta {
  return {
    source: meta.source,
    parentId: change.parentId === undefined ? meta.parentId : change.parentId,
    messageId:
      change.messageId === undefined ? meta.messageId : change.messageId,
    streamId: change.streamId === undefined ? meta.streamId : change.streamId,
    pendingModel: change.pendingModel ?? meta.pendingModel,
    steps: change.steps ?? meta.steps,
    interruptions: change.interruptions ?? meta.interruptions,
    overflowRetries: change.overflowRetries ?? meta.overflowRetries,
    abandonReason:
      change.abandonReason === undefined
        ? meta.abandonReason
        : change.abandonReason
  };
}

function inputJson(input: OperationInput): JsonValue {
  // SAFETY: an OperationInput is plain JSON: UI messages and tool answers
  // as clients send them, which the harness always stored as JSON.
  return input as unknown as JsonValue;
}

function parseInput(value: JsonValue): OperationInput {
  // SAFETY: inputs are stored only by `insert` (from an OperationInput) or
  // imported from the legacy table, which `insert` also wrote.
  return value as unknown as OperationInput;
}

function parseText(result: JsonValue): string | undefined {
  return isRecord(result) && typeof result.text === "string"
    ? result.text
    : undefined;
}

function parseSessionState(value: JsonValue | undefined): SessionState {
  if (!isRecord(value)) return EMPTY_STATE;
  const toolCalls: Record<string, StartedToolCall> = {};
  const calls = value.toolCalls;
  if (isRecord(calls)) {
    for (const [toolCallId, call] of Object.entries(calls)) {
      if (
        isRecord(call) &&
        typeof call.operationId === "string" &&
        typeof call.attempts === "number"
      ) {
        toolCalls[toolCallId] = {
          operationId: call.operationId,
          attempts: call.attempts
        };
      }
    }
  }
  return {
    clientTools: Array.isArray(value.clientTools)
      ? // SAFETY: written only by `setClientTools` from ClientToolSchema[],
        // or imported from the legacy column it also wrote.
        (value.clientTools as unknown as ClientToolSchema[])
      : [],
    toolCalls
  };
}

function sessionStateJson(state: SessionState): JsonValue {
  return {
    // SAFETY: a ClientToolSchema is plain JSON: a name, a description and
    // a JSON Schema.
    clientTools: state.clientTools as unknown as JsonValue,
    toolCalls: { ...state.toolCalls }
  };
}

function parseOperation(stored: StoredOperation): OperationRecord {
  const meta = parseMeta(stored.meta);
  return {
    session: stored.session,
    operationId: stored.id,
    seq: stored.seq,
    input: parseInput(stored.input),
    status: stored.status,
    source: meta.source,
    parentId: meta.parentId ?? undefined,
    messageId: meta.messageId ?? undefined,
    streamId: meta.streamId ?? undefined,
    pendingModel: meta.pendingModel,
    steps: meta.steps,
    interruptions: meta.interruptions,
    overflowRetries: meta.overflowRetries,
    reason: stored.reason,
    text: stored.status === "done" ? parseText(stored.result) : undefined,
    abandonReason: meta.abandonReason ?? undefined,
    createdAt: stored.createdAt
  };
}

/**
 * The harness's records, over the shared harness store: sessions, the
 * operation queue, and started tool calls. Opening it moves records an
 * earlier version left in its own tables into the store.
 */
export class OperationRecords {
  readonly #store: HarnessStore;

  /**
   * Open the records, creating the store's tables and importing any legacy
   * tables. Cheap after the first time: keep one per isolate.
   *
   * @param storage - The Durable Object's storage.
   */
  constructor(storage: DurableObjectStorage) {
    this.#store = openHarnessStore(storage, { prefix: STORE_PREFIX });
    importLegacyTables(storage, this.#store);
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  /** Record a session, unless it exists. */
  ensureSession(id: string, parent?: string): void {
    this.#store.createSession({
      id,
      ...(parent !== undefined && { parent }),
      state: sessionStateJson(EMPTY_STATE)
    });
  }

  /** Every session, oldest first. */
  sessions(): SessionRecord[] {
    return this.#store.sessions().map((session) => ({
      id: session.id,
      parent: session.parent,
      createdAt: session.createdAt
    }));
  }

  /** The client tools a session's client last declared. */
  clientTools(session: string): ClientToolSchema[] {
    return [...this.#state(session).clientTools];
  }

  /** Replace the client tools a session's client declared. */
  setClientTools(session: string, tools: readonly ClientToolSchema[]): void {
    this.#updateState(session, (state) => ({ ...state, clientTools: tools }));
  }

  #state(session: string): SessionState {
    return parseSessionState(this.#store.session(session)?.state);
  }

  #updateState(
    session: string,
    change: (state: SessionState) => SessionState
  ): void {
    this.#store.transaction(() => {
      const stored = this.#store.session(session);
      if (!stored) return;
      this.#store.setSessionState(
        session,
        sessionStateJson(change(parseSessionState(stored.state)))
      );
    });
  }

  // ── Operations ───────────────────────────────────────────────────────────

  /** Insert a queued operation. Returns false when the id already exists. */
  insert(
    session: string,
    operationId: string,
    input: OperationInput,
    source: "client" | "server"
  ): boolean {
    return this.#store.enqueue({
      session,
      id: operationId,
      input: inputJson(input),
      meta: metaJson(newMeta(source))
    }).accepted;
  }

  /** One operation. */
  get(session: string, operationId: string): OperationRecord | undefined {
    const stored = this.#store.operation(session, operationId);
    return stored ? parseOperation(stored) : undefined;
  }

  /** Unsettled operations, oldest first; every session when none is given. */
  open(session?: string): OperationRecord[] {
    return this.#store
      .operations({
        ...(session !== undefined && { session }),
        status: OPEN
      })
      .map(parseOperation);
  }

  /** Change an operation's progress. */
  update(
    session: string,
    operationId: string,
    change: OperationProgress
  ): void {
    this.#store.transaction(() => {
      const stored = this.#store.operation(session, operationId);
      if (!stored) return;
      this.#store.setOperationMeta(
        session,
        operationId,
        metaJson(withProgress(parseMeta(stored.meta), change))
      );
    });
  }

  /**
   * Move a queued operation to running, with its progress so far.
   * Returns false when it was not queued.
   */
  start(
    session: string,
    operationId: string,
    change: OperationProgress
  ): boolean {
    return this.#store.transaction(() => {
      if (!this.#store.start(session, operationId)) return false;
      this.update(session, operationId, change);
      return true;
    });
  }

  /**
   * Settle an open operation, with a last change to its progress. Returns
   * false when it had already settled.
   */
  settle(
    session: string,
    operationId: string,
    outcome: OperationSettlement,
    change: OperationProgress = {}
  ): boolean {
    return this.#store.transaction(() => {
      const settled = this.#store.settle(
        session,
        operationId,
        outcome.status === "done"
          ? { status: "done", result: { text: outcome.text } }
          : outcome
      );
      if (settled) this.update(session, operationId, change);
      return settled;
    });
  }

  /** Forget every settled operation in a session, for a reset. */
  deleteSettled(session: string): void {
    this.#store.transaction(() => {
      this.#store.deleteSettled(session);
      this.#updateState(session, (state) => ({ ...state, toolCalls: {} }));
    });
  }

  // ── Tool calls ───────────────────────────────────────────────────────────

  /** The record of a started tool call, if it was started. */
  toolCall(session: string, toolCallId: string): ToolCallRecord | undefined {
    const call = this.#state(session).toolCalls[toolCallId];
    return call && { session, toolCallId, ...call };
  }

  /** Record that a tool call is starting. Returns the attempt number. */
  startToolCall(
    session: string,
    toolCallId: string,
    operationId: string
  ): number {
    const attempts = (this.toolCall(session, toolCallId)?.attempts ?? 0) + 1;
    this.#updateState(session, (state) => ({
      ...state,
      toolCalls: { ...state.toolCalls, [toolCallId]: { operationId, attempts } }
    }));
    return attempts;
  }

  /** Forget a tool call once its result is in the transcript. */
  finishToolCall(session: string, toolCallId: string): void {
    this.#updateState(session, (state) => {
      const { [toolCallId]: _finished, ...toolCalls } = state.toolCalls;
      return { ...state, toolCalls };
    });
  }
}

// ── The legacy tables ──────────────────────────────────────────────────────

type LegacySessionRow = {
  id: string;
  parent: string | null;
  client_tools: string | null;
  created_at: number;
};

type LegacyToolCallRow = {
  session_id: string;
  tool_call_id: string;
  operation_id: string;
  attempts: number;
};

type LegacyOperationRow = {
  session_id: string;
  operation_id: string;
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
  /** Missing from tables created before the column was added. */
  abandon_reason?: string | null;
};

function parseJsonColumn(text: string): JsonValue {
  // SAFETY: the legacy columns were written with JSON.stringify.
  return JSON.parse(text) as JsonValue;
}

/**
 * Move the records an earlier version kept in its own tables into the
 * store, then drop those tables, in one transaction: either every record
 * moves or none does and the next start tries again. Operations keep their
 * order, status and progress; sessions keep their creation time, client
 * tools and started tool calls, so an operation that was in flight resumes
 * and recovers as it would have.
 */
function importLegacyTables(
  storage: DurableObjectStorage,
  store: HarnessStore
): void {
  const sql = storage.sql;
  const present = new Set(
    sql
      .exec<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)`,
        LEGACY_SESSIONS,
        LEGACY_OPERATIONS,
        LEGACY_TOOL_CALLS
      )
      .toArray()
      .map((row) => row.name)
  );
  if (present.size === 0) return;

  storage.transactionSync(() => {
    const states = new Map<string, SessionState>();
    if (present.has(LEGACY_SESSIONS)) {
      const rows = sql
        .exec<LegacySessionRow>(
          `SELECT id, parent, client_tools, created_at FROM ${LEGACY_SESSIONS}
           ORDER BY created_at, id`
        )
        .toArray();
      for (const row of rows) {
        store.createSession({
          id: row.id,
          ...(row.parent !== null && { parent: row.parent }),
          createdAt: row.created_at
        });
        states.set(
          row.id,
          parseSessionState({
            clientTools:
              row.client_tools === null
                ? []
                : parseJsonColumn(row.client_tools),
            toolCalls: {}
          })
        );
      }
    }
    if (present.has(LEGACY_TOOL_CALLS)) {
      const rows = sql
        .exec<LegacyToolCallRow>(
          `SELECT session_id, tool_call_id, operation_id, attempts
           FROM ${LEGACY_TOOL_CALLS}`
        )
        .toArray();
      for (const row of rows) {
        const state = states.get(row.session_id) ?? EMPTY_STATE;
        states.set(row.session_id, {
          ...state,
          toolCalls: {
            ...state.toolCalls,
            [row.tool_call_id]: {
              operationId: row.operation_id,
              attempts: row.attempts
            }
          }
        });
      }
    }
    for (const [id, state] of states) {
      // A session the legacy sessions table lacked is created here.
      store.createSession({ id });
      store.setSessionState(id, sessionStateJson(state));
    }

    if (present.has(LEGACY_OPERATIONS)) {
      const rows = sql
        .exec<LegacyOperationRow>(
          `SELECT * FROM ${LEGACY_OPERATIONS} ORDER BY seq`
        )
        .toArray();
      for (const row of rows) importLegacyOperation(store, row);
    }

    for (const table of [
      LEGACY_SESSIONS,
      LEGACY_OPERATIONS,
      LEGACY_TOOL_CALLS
    ]) {
      sql.exec(`DROP TABLE IF EXISTS ${table}`);
    }
  });
}

function importLegacyOperation(
  store: HarnessStore,
  row: LegacyOperationRow
): void {
  const session = row.session_id;
  const id = row.operation_id;
  if (!store.session(session)) {
    store.createSession({ id: session, state: sessionStateJson(EMPTY_STATE) });
  }
  const meta: OperationMeta = {
    source: row.source === "client" ? "client" : "server",
    parentId: row.parent_id,
    messageId: row.message_id,
    streamId: row.stream_id,
    pendingModel: row.pending_model === 1,
    steps: row.steps,
    interruptions: row.interruptions,
    overflowRetries: row.overflow_retries,
    abandonReason: row.abandon_reason ?? null
  };
  // Enqueued in the legacy order, so the store's order is the same.
  store.enqueue({
    session,
    id,
    input: parseJsonColumn(row.input),
    meta: metaJson(meta)
  });
  switch (row.status) {
    case "queued":
      return;
    case "running":
      store.start(session, id);
      return;
    case "done":
      store.settle(session, id, {
        status: "done",
        result: { text: row.text ?? "" }
      });
      return;
    case "unanswered":
      // Every legacy path that settled an operation unanswered gave a reason.
      store.settle(session, id, {
        status: "unanswered",
        reason: row.reason ?? "unanswered"
      });
      return;
    default:
      throw new Error(
        `Unknown ThinkHarness operation status ${row.status} in ${LEGACY_OPERATIONS}`
      );
  }
}
