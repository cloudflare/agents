/**
 * ThinkHarness's records in the shared, harness-agnostic store
 * (`agents/harness/store`), under the `cf_think_harness_store_` prefix:
 * which sessions exist and the client tools each declared. Operations are
 * Tasks runs; messages live in the Sessions capability and in-flight model
 * output in the Streams capability.
 *
 * The store once held the operations and the tool calls they started too.
 * {@link OperationRecords.leftOperations} reads what a released version left
 * open there, so the harness can carry it forward into runs, and
 * {@link OperationRecords.dropOperations} then forgets every operation.
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
  | {
      readonly kind: "messages";
      readonly messages: readonly UIMessage[];
      /** The participant whose client runs the answer's client tools. */
      readonly owner?: string;
    }
  /** Record a tool result or approval, then continue the turn it unblocks. */
  | {
      readonly kind: "answer";
      readonly answer: ToolAnswer;
      /** Whether to continue the turn once nothing else is awaited. */
      readonly autoContinue: boolean;
      /** The participant who sent the answer. */
      readonly from?: string;
    }
  /** Answer a user message again, on a new branch beside earlier answers. */
  | { readonly kind: "regenerate"; readonly messageId?: string }
  /** Continue the latest assistant message. */
  | { readonly kind: "continue" };

/**
 * An open operation a released version left in the store, with its progress
 * and the tool calls it started and did not finish.
 */
export type StoredOpenOperation = {
  readonly session: string;
  readonly operationId: string;
  readonly input: OperationInput;
  readonly status: "queued" | "running";
  readonly source: "client" | "server";
  readonly parentId: string | null;
  readonly messageId: string | null;
  readonly streamId: string | null;
  readonly pendingModel: boolean;
  readonly steps: number;
  readonly interruptions: number;
  readonly overflowRetries: number;
  /** Set when the memory-limit breaker sealed it. */
  readonly abandonReason: string | null;
  /** Tool calls it started, by id. */
  readonly startedToolCalls: string[];
  readonly createdAt: number;
};

/** A session the harness knows of. */
export type SessionRecord = {
  readonly id: string;
  readonly parent: string | undefined;
  readonly createdAt: number;
};

/** The shared store's table prefix for ThinkHarness's records. */
const STORE_PREFIX = "cf_think_harness_store_";

/** The tables ThinkHarness kept its records in before the shared store. */
const LEGACY_SESSIONS = "cf_think_harness_sessions";
const LEGACY_OPERATIONS = "cf_think_harness_operations";
const LEGACY_TOOL_CALLS = "cf_think_harness_tool_calls";

/** An operation's progress, as a released version kept it in `meta`. */
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

/** A started tool call, as a released version kept it in session state. */
type StartedToolCall = {
  readonly operationId: string;
  readonly attempts: number;
};

/** A session's harness-owned state, as kept in the store. */
type SessionState = {
  readonly clientTools: readonly ClientToolSchema[];
  /** Only in state a released version wrote; dropped with the operations. */
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

function metaJson(meta: OperationMeta): JsonValue {
  return { ...meta };
}

function parseInput(value: JsonValue): OperationInput {
  // SAFETY: inputs were stored by a released version from an
  // OperationInput, or imported from the legacy table it also wrote.
  return value as unknown as OperationInput;
}

function parseSessionState(value: JsonValue | undefined): SessionState {
  if (!isRecord(value)) return EMPTY_STATE;
  // Keyed by model-chosen ids, so no prototype: `__proto__` stays a key.
  const toolCalls: Record<string, StartedToolCall> = Object.create(null);
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
  const json: { [key: string]: JsonValue } = {
    // SAFETY: a ClientToolSchema is plain JSON: a name, a description and
    // a JSON Schema.
    clientTools: state.clientTools as unknown as JsonValue
  };
  if (Object.keys(state.toolCalls).length > 0) {
    json.toolCalls = { ...state.toolCalls };
  }
  return json;
}

function parseOpenOperation(
  stored: StoredOperation,
  state: SessionState
): StoredOpenOperation | undefined {
  if (stored.status !== "queued" && stored.status !== "running") return;
  const meta = parseMeta(stored.meta);
  return {
    session: stored.session,
    operationId: stored.id,
    input: parseInput(stored.input),
    status: stored.status,
    ...meta,
    startedToolCalls: Object.entries(state.toolCalls)
      .filter(([, call]) => call.operationId === stored.id)
      .map(([toolCallId]) => toolCallId),
    createdAt: stored.createdAt
  };
}

/**
 * The harness's records over the shared harness store: sessions and their
 * client tools. Opening it moves records an earlier version left in its
 * own tables into the store.
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

  // ── Operations a released version left ───────────────────────────────────

  /**
   * The operations a released version left: `undefined` when the store
   * holds none (every start after the first), else the open ones in
   * submission order.
   */
  leftOperations(): StoredOpenOperation[] | undefined {
    const stored = this.#store.operations();
    if (stored.length === 0) return undefined;
    const states = new Map<string, SessionState>();
    const open: StoredOpenOperation[] = [];
    for (const operation of stored) {
      let state = states.get(operation.session);
      if (!state) {
        state = this.#state(operation.session);
        states.set(operation.session, state);
      }
      const parsed = parseOpenOperation(operation, state);
      if (parsed) open.push(parsed);
    }
    return open;
  }

  /**
   * Forget every operation and started tool call the store holds, once the
   * open ones were carried forward.
   */
  dropOperations(): void {
    this.#store.transaction(() => {
      for (const operation of this.#store.operations()) {
        this.#store.deleteOperation(operation.session, operation.id);
      }
      for (const session of this.#store.sessions()) {
        if (Object.keys(parseSessionState(session.state).toolCalls).length) {
          this.#updateState(session.id, (state) => ({
            ...state,
            toolCalls: {}
          }));
        }
      }
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
  // Legacy tables exist beside the store only after a rollback to a version
  // that cannot see the store, so a legacy row is the newer record of its
  // id: it replaces the store's.
  store.deleteOperation(session, id);
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
