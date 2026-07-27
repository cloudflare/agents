import type { UIMessage, UIMessageChunk } from "ai";
import type { TurnState } from "../engine/turn-state";
import type {
  CompletedInteraction,
  JournalEntry,
  TurnOrigin,
  TurnOutcome
} from "../types";
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from "./schema";

/** One ledger row. The engine's unit of truth. */
export interface TurnRecord {
  id: string;
  conversationId: string;
  sourceEventId: string | null;
  origin: TurnOrigin;
  principal: string | null;
  state: TurnState;
  outcome: TurnOutcome | null;
  errorText: string | null;
  input: UIMessage[];
  /** Next journal seq to allocate; equals the journal's current length. */
  nextSeq: number;
  /** Journal seq where the current post-interaction continuation starts. */
  continuationFromSeq: number;
  createdAt: number;
  updatedAt: number;
  settledAt: number | null;
}

export interface NewTurn {
  id: string;
  conversationId: string;
  sourceEventId: string | null;
  origin: TurnOrigin;
  principal: string | null;
  input: UIMessage[];
  at: number;
}

export interface InteractionRecord {
  id: string;
  turnId: string;
  kind: string;
  payload: unknown;
  status: "pending" | "completed";
  value: unknown;
  createdAt: number;
  completedAt: number | null;
}

/**
 * The Storage port: everything the engine (and identity) durably knows,
 * as typed transactional operations. Implementations own the tables;
 * nothing outside this module touches SQLite directly.
 */
export interface TurnStore {
  /** Run `fn` atomically. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T;

  // ── Turns (ledger) ──────────────────────────────────────────────────
  insertTurn(turn: NewTurn): TurnRecord;
  getTurn(id: string): TurnRecord | undefined;
  findTurnBySourceEvent(
    conversationId: string,
    sourceEventId: string
  ): TurnRecord | undefined;
  /**
   * Compare-and-set state change: applies only when the row is still in
   * `from`, so a stale writer can never regress the ledger. Returns the
   * updated record, or undefined when the row moved on.
   */
  transitionTurn(
    id: string,
    from: TurnState,
    to: TurnState,
    patch: {
      at: number;
      outcome?: TurnOutcome;
      errorText?: string;
      continuationFromSeq?: number;
    }
  ): TurnRecord | undefined;
  listUnsettledTurns(): TurnRecord[];

  // ── Journal (turn_chunks) ───────────────────────────────────────────
  /** Append one chunk, allocating the next seq atomically. */
  appendChunk(turnId: string, chunk: UIMessageChunk): number;
  listChunks(turnId: string, fromSeq: number): JournalEntry[];
  /** Drop a never-visible journal before an accepted-stage re-run. */
  clearChunks(turnId: string): void;
  /** Prune journals of turns settled at or before `cutoff`. */
  pruneChunks(cutoff: number): void;
  /** Earliest `settled_at` among settled turns that still have chunks. */
  earliestPrunableSettledAt(): number | undefined;

  // ── Interactions ────────────────────────────────────────────────────
  /**
   * Record a pending interaction. Writing an existing id re-opens it
   * (back to pending, value cleared) — connectors may reuse stable ids
   * across re-pauses without wedging a turn on a key violation.
   */
  upsertInteraction(interaction: {
    id: string;
    turnId: string;
    kind: string;
    payload: unknown;
    at: number;
  }): void;
  getInteraction(id: string): InteractionRecord | undefined;
  /** Mark pending → completed; returns false when it already completed. */
  completeInteraction(id: string, value: unknown, at: number): boolean;
  listCompletedInteractions(turnId: string): CompletedInteraction[];

  // ── Connector state (scoped KV) ─────────────────────────────────────
  kvGet(conversationId: string, key: string): unknown;
  kvSet(conversationId: string, key: string, value: unknown): void;
  kvDelete(conversationId: string, key: string): void;
}

/**
 * The slice of `DurableObjectStorage` the SQLite store needs. Structural,
 * so tests can substitute any synchronous transactional SQLite handle.
 */
export interface SqliteHandle {
  sql: SqlStorage;
  transactionSync<T>(closure: () => T): T;
}

interface TurnRow extends Record<string, SqlStorageValue> {
  id: string;
  conversation_id: string;
  source_event_id: string | null;
  origin: string;
  principal: string | null;
  state: string;
  outcome: string | null;
  error_text: string | null;
  input: string;
  next_seq: number;
  continuation_from_seq: number;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
}

export class SqliteTurnStore implements TurnStore {
  private schemaReady = false;

  constructor(private readonly storage: SqliteHandle) {}

  transaction<T>(fn: () => T): T {
    this.ensureSchema();
    return this.storage.transactionSync(fn);
  }

  // ── Turns ───────────────────────────────────────────────────────────

  insertTurn(turn: NewTurn): TurnRecord {
    this.exec(
      `INSERT INTO cf_channels_turns
        (id, conversation_id, source_event_id, origin, principal, state, input,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?, ?)`,
      turn.id,
      turn.conversationId,
      turn.sourceEventId,
      turn.origin,
      turn.principal,
      JSON.stringify(turn.input),
      turn.at,
      turn.at
    );
    const inserted = this.getTurn(turn.id);
    if (!inserted) {
      throw new Error(`Turn ${turn.id} vanished on insert`);
    }
    return inserted;
  }

  getTurn(id: string): TurnRecord | undefined {
    const row = this.exec<TurnRow>(
      "SELECT * FROM cf_channels_turns WHERE id = ?",
      id
    ).toArray()[0];
    return row && turnFromRow(row);
  }

  findTurnBySourceEvent(
    conversationId: string,
    sourceEventId: string
  ): TurnRecord | undefined {
    const row = this.exec<TurnRow>(
      `SELECT * FROM cf_channels_turns
       WHERE conversation_id = ? AND source_event_id = ?`,
      conversationId,
      sourceEventId
    ).toArray()[0];
    return row && turnFromRow(row);
  }

  transitionTurn(
    id: string,
    from: TurnState,
    to: TurnState,
    patch: {
      at: number;
      outcome?: TurnOutcome;
      errorText?: string;
      continuationFromSeq?: number;
    }
  ): TurnRecord | undefined {
    return this.transaction(() => {
      const updated = this.exec<TurnRow>(
        `UPDATE cf_channels_turns SET
           state = ?,
           updated_at = ?,
           outcome = COALESCE(?, outcome),
           error_text = COALESCE(?, error_text),
           continuation_from_seq = COALESCE(?, continuation_from_seq),
           settled_at = CASE WHEN ? = 'settled' THEN ? ELSE settled_at END
         WHERE id = ? AND state = ?
         RETURNING *`,
        to,
        patch.at,
        patch.outcome ?? null,
        patch.errorText ?? null,
        patch.continuationFromSeq ?? null,
        to,
        patch.at,
        id,
        from
      ).toArray()[0];
      return updated && turnFromRow(updated);
    });
  }

  listUnsettledTurns(): TurnRecord[] {
    return this.exec<TurnRow>(
      `SELECT * FROM cf_channels_turns
       WHERE state != 'settled' ORDER BY created_at ASC`
    )
      .toArray()
      .map(turnFromRow);
  }

  // ── Journal ─────────────────────────────────────────────────────────

  appendChunk(turnId: string, chunk: UIMessageChunk): number {
    return this.transaction(() => {
      const row = this.exec<{ next_seq: number }>(
        "SELECT next_seq FROM cf_channels_turns WHERE id = ?",
        turnId
      ).toArray()[0];
      if (!row) {
        throw new Error(`Cannot journal a chunk for unknown turn ${turnId}`);
      }
      const seq = row.next_seq;
      this.exec(
        "INSERT INTO cf_channels_turn_chunks (turn_id, seq, chunk) VALUES (?, ?, ?)",
        turnId,
        seq,
        JSON.stringify(chunk)
      );
      this.exec(
        "UPDATE cf_channels_turns SET next_seq = ? WHERE id = ?",
        seq + 1,
        turnId
      );
      return seq;
    });
  }

  listChunks(turnId: string, fromSeq: number): JournalEntry[] {
    return this.exec<{ seq: number; chunk: string }>(
      `SELECT seq, chunk FROM cf_channels_turn_chunks
       WHERE turn_id = ? AND seq >= ? ORDER BY seq ASC`,
      turnId,
      fromSeq
    )
      .toArray()
      .map((row) => ({
        chunk: JSON.parse(row.chunk) as UIMessageChunk,
        seq: row.seq
      }));
  }

  clearChunks(turnId: string): void {
    this.transaction(() => {
      this.exec(
        "DELETE FROM cf_channels_turn_chunks WHERE turn_id = ?",
        turnId
      );
      this.exec(
        `UPDATE cf_channels_turns
         SET next_seq = 0, continuation_from_seq = 0
         WHERE id = ?`,
        turnId
      );
    });
  }

  pruneChunks(cutoff: number): void {
    this.exec(
      `DELETE FROM cf_channels_turn_chunks WHERE turn_id IN (
         SELECT id FROM cf_channels_turns
         WHERE state = 'settled' AND settled_at <= ?
       )`,
      cutoff
    );
  }

  earliestPrunableSettledAt(): number | undefined {
    const row = this.exec<{ earliest: number | null }>(
      `SELECT MIN(settled_at) AS earliest FROM cf_channels_turns
       WHERE state = 'settled' AND id IN (
         SELECT DISTINCT turn_id FROM cf_channels_turn_chunks
       )`
    ).toArray()[0];
    return row?.earliest ?? undefined;
  }

  // ── Interactions ────────────────────────────────────────────────────

  upsertInteraction(interaction: {
    id: string;
    turnId: string;
    kind: string;
    payload: unknown;
    at: number;
  }): void {
    this.exec(
      `INSERT INTO cf_channels_interactions
        (id, turn_id, kind, payload, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)
       ON CONFLICT (id) DO UPDATE SET
         turn_id = excluded.turn_id,
         kind = excluded.kind,
         payload = excluded.payload,
         status = 'pending',
         value = NULL,
         completed_at = NULL,
         created_at = excluded.created_at`,
      interaction.id,
      interaction.turnId,
      interaction.kind,
      JSON.stringify(interaction.payload ?? null),
      interaction.at
    );
  }

  getInteraction(id: string): InteractionRecord | undefined {
    const row = this.exec<{
      id: string;
      turn_id: string;
      kind: string;
      payload: string | null;
      status: string;
      value: string | null;
      created_at: number;
      completed_at: number | null;
    }>("SELECT * FROM cf_channels_interactions WHERE id = ?", id).toArray()[0];
    if (!row) {
      return undefined;
    }
    return {
      completedAt: row.completed_at,
      createdAt: row.created_at,
      id: row.id,
      kind: row.kind,
      payload: parseNullable(row.payload),
      status: row.status as InteractionRecord["status"],
      turnId: row.turn_id,
      value: parseNullable(row.value)
    };
  }

  completeInteraction(id: string, value: unknown, at: number): boolean {
    const updated = this.exec<{ id: string }>(
      `UPDATE cf_channels_interactions
       SET status = 'completed', value = ?, completed_at = ?
       WHERE id = ? AND status = 'pending'
       RETURNING id`,
      JSON.stringify(value ?? null),
      at,
      id
    ).toArray();
    return updated.length > 0;
  }

  listCompletedInteractions(turnId: string): CompletedInteraction[] {
    return this.exec<{
      id: string;
      kind: string;
      payload: string | null;
      value: string | null;
    }>(
      `SELECT id, kind, payload, value FROM cf_channels_interactions
       WHERE turn_id = ? AND status = 'completed' ORDER BY created_at ASC`,
      turnId
    )
      .toArray()
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        payload: parseNullable(row.payload),
        value: parseNullable(row.value)
      }));
  }

  // ── Connector state ─────────────────────────────────────────────────

  kvGet(conversationId: string, key: string): unknown {
    const row = this.exec<{ value: string }>(
      "SELECT value FROM cf_channels_connector_state WHERE conversation_id = ? AND key = ?",
      conversationId,
      key
    ).toArray()[0];
    return row === undefined ? undefined : JSON.parse(row.value);
  }

  kvSet(conversationId: string, key: string, value: unknown): void {
    this.exec(
      `INSERT INTO cf_channels_connector_state (conversation_id, key, value)
       VALUES (?, ?, ?)
       ON CONFLICT (conversation_id, key) DO UPDATE SET value = excluded.value`,
      conversationId,
      key,
      JSON.stringify(value)
    );
  }

  kvDelete(conversationId: string, key: string): void {
    this.exec(
      "DELETE FROM cf_channels_connector_state WHERE conversation_id = ? AND key = ?",
      conversationId,
      key
    );
  }

  // ── Internals ───────────────────────────────────────────────────────

  private exec<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursor<T> {
    this.ensureSchema();
    return this.storage.sql.exec<T>(query, ...(bindings as SqlStorageValue[]));
  }

  private ensureSchema(): void {
    if (this.schemaReady) {
      return;
    }
    for (const statement of SCHEMA_STATEMENTS) {
      this.storage.sql.exec(statement);
    }
    this.storage.sql.exec(
      `INSERT INTO cf_channels_meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      String(SCHEMA_VERSION)
    );
    this.schemaReady = true;
  }
}

/** Absent values round-trip as JSON `null`; expose them as undefined. */
function parseNullable(raw: string | null): unknown {
  if (raw === null) {
    return undefined;
  }
  return (JSON.parse(raw) as unknown) ?? undefined;
}

function turnFromRow(row: TurnRow): TurnRecord {
  return {
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    sourceEventId: row.source_event_id,
    continuationFromSeq: row.continuation_from_seq,
    errorText: row.error_text,
    id: row.id,
    input: JSON.parse(row.input) as UIMessage[],
    nextSeq: row.next_seq,
    origin: row.origin as TurnOrigin,
    outcome: row.outcome as TurnOutcome | null,
    principal: row.principal,
    settledAt: row.settled_at,
    state: row.state as TurnState,
    updatedAt: row.updated_at
  };
}
