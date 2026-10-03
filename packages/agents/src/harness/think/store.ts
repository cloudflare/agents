import type { ThinkTurnRecord, ThinkTurnStatus } from "./types";

type TurnRow = {
  turn_id: string;
  chat: string;
  status: ThinkTurnRecord["status"];
  step: number;
  message_id: string;
  error: string | null;
  started_at: number;
  ended_at: number | null;
};

function decodeTurn(row: TurnRow): ThinkTurnRecord {
  return {
    turnId: row.turn_id,
    chat: row.chat,
    status: row.status,
    step: row.step,
    messageId: row.message_id,
    error: row.error,
    startedAt: row.started_at,
    endedAt: row.ended_at
  };
}

/**
 * The harness's own records: one row per turn, and one per tool call that
 * started. The transcript holds everything else.
 */
export class ThinkStore {
  readonly #storage: DurableObjectStorage;
  readonly #failed: (error: unknown) => never;
  #ready = false;

  /** `failed` rethrows a storage error as the caller's own error type. */
  constructor(
    storage: DurableObjectStorage,
    failed: (error: unknown) => never
  ) {
    this.#storage = storage;
    this.#failed = failed;
  }

  #exec<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursor<T> {
    try {
      return this.#storage.sql.exec<T>(query, ...bindings);
    } catch (error) {
      return this.#failed(error);
    }
  }

  #ensure(): void {
    if (this.#ready) return;
    this.#exec(`
      CREATE TABLE IF NOT EXISTS cf_agents_think_turns (
        turn_id TEXT PRIMARY KEY NOT NULL,
        chat TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('running', 'completed', 'error', 'stopped')),
        step INTEGER NOT NULL DEFAULT 0,
        message_id TEXT NOT NULL,
        error TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS cf_agents_think_turns_chat
        ON cf_agents_think_turns (chat, status);
      CREATE TABLE IF NOT EXISTS cf_agents_think_tool_calls (
        tool_call_id TEXT PRIMARY KEY NOT NULL,
        turn_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        settled_at INTEGER
      );
    `);
    this.#ready = true;
  }

  turn(turnId: string): ThinkTurnRecord | undefined {
    this.#ensure();
    const row = this.#exec<TurnRow>(
      "SELECT * FROM cf_agents_think_turns WHERE turn_id = ?",
      turnId
    ).toArray()[0];
    return row ? decodeTurn(row) : undefined;
  }

  running(chat: string): ThinkTurnRecord | undefined {
    this.#ensure();
    const row = this.#exec<TurnRow>(
      `SELECT * FROM cf_agents_think_turns
         WHERE chat = ? AND status = 'running'
         ORDER BY started_at DESC LIMIT 1`,
      chat
    ).toArray()[0];
    return row ? decodeTurn(row) : undefined;
  }

  /** Record a new running turn. A repeat for the same id keeps the first. */
  begin(turnId: string, chat: string, messageId: string): ThinkTurnRecord {
    this.#ensure();
    this.#exec(
      `INSERT INTO cf_agents_think_turns
        (turn_id, chat, status, step, message_id, started_at)
       VALUES (?, ?, 'running', 0, ?, ?)
       ON CONFLICT (turn_id) DO NOTHING`,
      turnId,
      chat,
      messageId,
      Date.now()
    );
    const turn = this.turn(turnId);
    if (!turn) throw new Error(`Failed to record turn ${turnId}`);
    return turn;
  }

  completeStep(turnId: string): void {
    this.#ensure();
    this.#exec(
      `UPDATE cf_agents_think_turns SET step = step + 1
       WHERE turn_id = ? AND status = 'running'`,
      turnId
    );
  }

  /** End a running turn. Returns false when it had already ended. */
  end(turnId: string, status: ThinkTurnStatus, error?: string): boolean {
    this.#ensure();
    return (
      this.#exec(
        `UPDATE cf_agents_think_turns
         SET status = ?, error = ?, ended_at = ?
         WHERE turn_id = ? AND status = 'running'`,
        status,
        error ?? null,
        Date.now(),
        turnId
      ).rowsWritten > 0
    );
  }

  /** Written right before a tool runs, so an eviction mid-call is visible. */
  toolStarted(toolCallId: string, turnId: string): void {
    this.#ensure();
    this.#exec(
      `INSERT INTO cf_agents_think_tool_calls (tool_call_id, turn_id, started_at)
       VALUES (?, ?, ?)
       ON CONFLICT (tool_call_id) DO NOTHING`,
      toolCallId,
      turnId,
      Date.now()
    );
  }

  toolSettled(toolCallId: string): void {
    this.#ensure();
    this.#exec(
      `UPDATE cf_agents_think_tool_calls SET settled_at = ?
       WHERE tool_call_id = ?`,
      Date.now(),
      toolCallId
    );
  }

  /** True when a call started and never recorded a result. */
  toolInterrupted(toolCallId: string): boolean {
    this.#ensure();
    const row = this.#exec<{ settled_at: number | null }>(
      "SELECT settled_at FROM cf_agents_think_tool_calls WHERE tool_call_id = ?",
      toolCallId
    ).toArray()[0];
    return row !== undefined && row.settled_at === null;
  }

  clear(chat: string): void {
    this.#ensure();
    this.#exec(
      `DELETE FROM cf_agents_think_tool_calls WHERE turn_id IN
         (SELECT turn_id FROM cf_agents_think_turns WHERE chat = ?)`,
      chat
    );
    this.#exec(
      "DELETE FROM cf_agents_think_turns WHERE chat = ? AND status != 'running'",
      chat
    );
  }
}
