/**
 * What an operation asks the harness to do, and what released versions of
 * ThinkHarness kept of their own: the shared harness store
 * (`agents/harness/store`, prefix `cf_think_harness_store_`) with sessions,
 * their client tools and operations, and before it the 0.27 tables. The
 * harness now keeps sessions and client tools in Sessions and operations in
 * Tasks; {@link ReleasedRecords} is what it reads once, at start, to carry
 * those records forward.
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
import { hasTable } from "../../lifecycle/schema";

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
  | { readonly kind: "continue" }
  /**
   * @internal Answer the history as it stands, with a new assistant message
   * after the latest message: Think's `continueLastTurn()` and an empty
   * `saveMessages()`. Brings no message of its own.
   */
  | { readonly kind: "reply" };

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

/** A session a released version knew of. */
export type ReleasedSession = {
  readonly id: string;
  readonly parent: string | undefined;
  readonly createdAt: number;
  readonly clientTools: readonly ClientToolSchema[];
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
  return {
    // SAFETY: a ClientToolSchema is plain JSON: a name, a description and
    // a JSON Schema.
    clientTools: state.clientTools as unknown as JsonValue,
    toolCalls: { ...state.toolCalls }
  };
}

function parseOpenOperation(
  stored: StoredOperation,
  state: SessionState
): StoredOpenOperation {
  const meta = parseMeta(stored.meta);
  return {
    session: stored.session,
    operationId: stored.id,
    input: parseInput(stored.input),
    status: stored.status === "running" ? "running" : "queued",
    ...meta,
    startedToolCalls: Object.entries(state.toolCalls)
      .filter(([, call]) => call.operationId === stored.id)
      .map(([toolCallId]) => toolCallId),
    createdAt: stored.createdAt
  };
}

/** The store's tables, by their suffix after the prefix. */
const STORE_TABLES = ["sessions", "operations", "log"] as const;

/**
 * What a released version kept in the shared harness store, or before that
 * in the 0.27 tables: sessions with their client tools, and operations.
 * Opened only at start and only when those tables are there; the harness
 * moves what it holds into Sessions and Tasks, then drops the tables.
 */
export class ReleasedRecords {
  readonly #storage: DurableObjectStorage;
  readonly #store: HarnessStore;
  readonly #facet: boolean;

  /**
   * The records, or `undefined` when no table of a released version is
   * there. Run once per object, as a schema step.
   */
  static open(
    storage: DurableObjectStorage,
    facet: boolean
  ): ReleasedRecords | undefined {
    const present = new Set(
      [
        ...STORE_TABLES.map((table) => `${STORE_PREFIX}${table}`),
        LEGACY_SESSIONS,
        LEGACY_OPERATIONS,
        LEGACY_TOOL_CALLS
      ].filter((name) => hasTable(storage.sql, name))
    );
    return present.size === 0
      ? undefined
      : new ReleasedRecords(storage, present, facet);
  }

  private constructor(
    storage: DurableObjectStorage,
    present: Set<string>,
    facet: boolean
  ) {
    this.#storage = storage;
    this.#facet = facet;
    this.#store = openHarnessStore(storage, { prefix: STORE_PREFIX });
    importLegacyTables(storage, this.#store, present, this.#discard);
  }

  /**
   * A table this is done with. A facet empties it rather than dropping it:
   * a facet dropping indexed tables on its first start after an upgrade
   * has reset its whole tree's storage (measured; only the root drops).
   */
  readonly #discard = (table: string): void => {
    this.#storage.sql.exec(
      this.#facet ? `DELETE FROM ${table}` : `DROP TABLE IF EXISTS ${table}`
    );
  };

  /**
   * Sessions, oldest first, with the client tools each declared: `limit`
   * of them from `offset`.
   */
  sessions(offset: number, limit: number): ReleasedSession[] {
    return this.#store.sessions({ offset, limit }).map((session) => ({
      id: session.id,
      parent: session.parent,
      createdAt: session.createdAt,
      clientTools: parseSessionState(session.state).clientTools
    }));
  }

  /**
   * The oldest open operations, at most `limit`, in submission order. Only
   * those rows are read: settled ones can be many, and hold whole messages.
   */
  leftOperations(limit: number): StoredOpenOperation[] {
    const states = new Map<string, SessionState>();
    return this.#store
      .operations({ status: ["queued", "running"], limit })
      .map((operation) => {
        let state = states.get(operation.session);
        if (!state) {
          state = parseSessionState(
            this.#store.session(operation.session)?.state
          );
          states.set(operation.session, state);
        }
        return parseOpenOperation(operation, state);
      });
  }

  /** Forget open operations once they are runs. */
  dropOperations(carried: readonly StoredOpenOperation[]): void {
    this.#store.transaction(() => {
      for (const operation of carried) {
        this.#store.deleteOperation(operation.session, operation.operationId);
      }
    });
  }

  /** Discard the store's tables, settled operations and all, unread. */
  drop(): void {
    this.#storage.transactionSync(() => {
      for (const table of STORE_TABLES)
        this.#discard(`${STORE_PREFIX}${table}`);
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
  store: HarnessStore,
  present: ReadonlySet<string>,
  discard: (table: string) => void
): void {
  const sql = storage.sql;
  if (
    !present.has(LEGACY_SESSIONS) &&
    !present.has(LEGACY_OPERATIONS) &&
    !present.has(LEGACY_TOOL_CALLS)
  ) {
    return;
  }

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
      if (present.has(table)) discard(table);
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
