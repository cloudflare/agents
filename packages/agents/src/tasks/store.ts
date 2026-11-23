/**
 * Storage layer for the Tasks capability: owns the `cf_agents_task_runs`,
 * `cf_agents_task_steps` and `cf_agents_task_checkpoint` tables — DDL, row access, generation-fenced writes,
 * and the snapshot projection. The engine in `tasks.ts` holds the state
 * machine; every byte that touches SQLite goes through here.
 */

import { SqlError } from "../sql-error";
import {
  deserializeTaskValue,
  INLINE_INPUT_UNITS,
  splitPieces
} from "./serialization";
import type {
  TaskJson,
  TaskRecord,
  TaskRunRow,
  TaskRunSnapshot,
  TaskValue
} from "./types";

/** Columns of `cf_agents_task_runs`. */
const RUNS_COLUMNS = `
        run_id TEXT PRIMARY KEY,
        definition TEXT NOT NULL,
        input TEXT,
        status TEXT NOT NULL CHECK (status IN (
          'pending', 'running', 'completed', 'error', 'aborted', 'skipped'
        )),
        result TEXT,
        error_name TEXT,
        error_message TEXT,
        status_message TEXT,
        metadata TEXT,
        idempotency_key TEXT,
        retain INTEGER NOT NULL DEFAULT 1,
        attempt INTEGER NOT NULL DEFAULT 0,
        generation TEXT,
        next_at INTEGER,
        wait_reason TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        cancel_reason TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        updated_at INTEGER NOT NULL,
        settled_at INTEGER,
        lane TEXT,
        seq INTEGER,
        notified TEXT,
        input_parts INTEGER
      `;

/** @internal SQL-backed store for one Tasks capability instance. */
export class TaskStore {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[] {
    const query = strings.reduce(
      (result, part, index) =>
        result + part + (index < values.length ? "?" : ""),
      ""
    );
    try {
      // SAFETY: Tasks queries select from its own schema; T describes the
      // projected columns of the accompanying query text.
      return [...this.#storage.sql.exec(query, ...values)] as T[];
    } catch (cause) {
      throw new SqlError(query, cause);
    }
  }

  write(query: string, params: (string | number | null)[]): number {
    try {
      return this.#storage.sql.exec(query, ...params).rowsWritten;
    } catch (cause) {
      throw new SqlError(query, cause);
    }
  }

  /**
   * Run one generation-fenced run mutation. Returns false when the fence
   * rejected it because another attempt superseded this one.
   */
  fencedWrite(
    runId: string,
    generation: string,
    query: string,
    leadingParams: (string | number | null)[]
  ): boolean {
    try {
      const cursor = this.#storage.sql.exec(
        query,
        ...leadingParams,
        runId,
        generation
      );
      return cursor.rowsWritten > 0;
    } catch (cause) {
      throw new SqlError(query, cause);
    }
  }

  getRun(runId: string): TaskRunRow | undefined {
    const rows = this.sql<TaskRunRow>`
      SELECT * FROM cf_agents_task_runs WHERE run_id = ${runId}
    `;
    return rows[0];
  }

  /**
   * The run a lane runs next: its oldest open run (an interrupted one is
   * older than anything queued behind it).
   */
  laneHead(lane: string): TaskRunRow | undefined {
    return this.sql<TaskRunRow>`
      SELECT * FROM cf_agents_task_runs
      WHERE lane = ${lane} AND status IN ('pending', 'running')
      ORDER BY seq LIMIT 1
    `[0];
  }

  /** The sequence number the next run of `lane` gets. */
  nextLaneSeq(lane: string): number {
    return (
      (this.sql<{ seq: number | null }>`
        SELECT MAX(seq) AS seq FROM cf_agents_task_runs WHERE lane = ${lane}
      `[0]?.seq ?? 0) + 1
    );
  }

  getRunByKey(idempotencyKey: string): TaskRunRow | undefined {
    const rows = this.sql<TaskRunRow>`
      SELECT * FROM cf_agents_task_runs WHERE idempotency_key = ${idempotencyKey}
    `;
    return rows[0];
  }

  /**
   * Store a run's input: in its row, or past the row's room in pieces.
   *
   * @returns What the row's `input` and `input_parts` columns hold.
   */
  placeInput(
    runId: string,
    json: string | null
  ): { input: string | null; parts: number | null } {
    if (json === null || json.length <= INLINE_INPUT_UNITS) {
      return { input: json, parts: null };
    }
    const pieces = splitPieces(json, INLINE_INPUT_UNITS);
    pieces.forEach((data, piece) => {
      this.sql`
        INSERT INTO cf_agents_task_parts (run_id, piece, data)
        VALUES (${runId}, ${piece}, ${data})
      `;
    });
    return { input: null, parts: pieces.length };
  }

  /** A run's input JSON, joined from its pieces when it has them. */
  inputJson(row: TaskRunRow): string | null {
    if (row.input_parts === null || row.input_parts === undefined) {
      return row.input;
    }
    return this.sql<{ data: string }>`
      SELECT data FROM cf_agents_task_parts
      WHERE run_id = ${row.run_id} ORDER BY piece
    `
      .map((part) => part.data)
      .join("");
  }

  deleteRun(runId: string): void {
    this.sql`DELETE FROM cf_agents_task_parts WHERE run_id = ${runId}`;
    this.deleteCheckpoint(runId);
    this.sql`DELETE FROM cf_agents_task_steps WHERE run_id = ${runId}`;
    this.sql`DELETE FROM cf_agents_task_runs WHERE run_id = ${runId}`;
  }

  /** A checkpoint entry of a run, or `undefined`. */
  getCheckpoint(runId: string, key: string): TaskJson | undefined {
    const rows = this.sql<{ value: string }>`
      SELECT value FROM cf_agents_task_checkpoint
      WHERE run_id = ${runId} AND key = ${key}
    `;
    return rows[0] === undefined
      ? undefined
      : (JSON.parse(rows[0].value) as TaskJson);
  }

  /**
   * Write a checkpoint entry for the attempt holding `generation`. A
   * superseded attempt writes nothing.
   */
  setCheckpoint(
    runId: string,
    generation: string,
    key: string,
    value: TaskJson
  ): void {
    this.write(
      `INSERT INTO cf_agents_task_checkpoint (run_id, key, value)
       SELECT ?, ?, ? WHERE EXISTS (
         SELECT 1 FROM cf_agents_task_runs WHERE run_id = ? AND generation = ?
       )
       ON CONFLICT (run_id, key) DO UPDATE SET value = excluded.value`,
      [runId, key, JSON.stringify(value), runId, generation]
    );
  }

  deleteCheckpoint(runId: string): void {
    this.sql`DELETE FROM cf_agents_task_checkpoint WHERE run_id = ${runId}`;
  }

  /**
   * Rebuild `cf_agents_task_runs` in the current shape, in one transaction,
   * keeping every run. From schema 1 the `state` column becomes `status`,
   * with `waiting` folded into `pending` (its `wait_reason` says why),
   * `failed` renamed `error` and `cancelled` renamed `aborted`. From 1 or 2
   * the table gains lanes (`lane`, `seq`) and the `skipped` status, and
   * the idempotency key's index becomes partial (keyless runs write none).
   */
  rebuildRuns(): void {
    const columns = new Set(
      this.sql<{ name: string }>`
        SELECT name FROM pragma_table_info('cf_agents_task_runs')
      `.map((row) => row.name)
    );
    if (columns.size === 0) return;
    const status = columns.has("state")
      ? `CASE state
           WHEN 'waiting' THEN 'pending'
           WHEN 'failed' THEN 'error'
           WHEN 'cancelled' THEN 'aborted'
           ELSE state
         END`
      : "status";
    const lane = columns.has("lane") ? "lane, seq" : "NULL, NULL";
    const notified = columns.has("notified") ? "notified" : "NULL";
    const parts = columns.has("input_parts") ? "input_parts" : "NULL";
    this.#storage.transactionSync(() => {
      const exec = (query: string) => {
        try {
          this.#storage.sql.exec(query);
        } catch (cause) {
          throw new SqlError(query, cause);
        }
      };
      exec(
        `CREATE TABLE cf_agents_task_runs_next (${RUNS_COLUMNS}) WITHOUT ROWID`
      );
      exec(`
        INSERT INTO cf_agents_task_runs_next (
          run_id, definition, input, status, result, error_name,
          error_message, status_message, metadata, idempotency_key, retain,
          attempt, generation, next_at, wait_reason, cancel_requested,
          cancel_reason, created_at, started_at, updated_at, settled_at,
          lane, seq, notified, input_parts
        )
        SELECT
          run_id, definition, input, ${status},
          result, error_name, error_message, status_message, metadata,
          idempotency_key, retain, attempt, generation, next_at, wait_reason,
          cancel_requested, cancel_reason, created_at, started_at, updated_at,
          settled_at, ${lane}, ${notified}, ${parts}
        FROM cf_agents_task_runs`);
      exec(`DROP TABLE cf_agents_task_runs`);
      exec(
        `ALTER TABLE cf_agents_task_runs_next RENAME TO cf_agents_task_runs`
      );
    });
  }

  ensureTables(): void {
    const rawSql = (query: string) => {
      try {
        this.#storage.sql.exec(query);
      } catch (cause) {
        throw new SqlError(query, cause);
      }
    };
    rawSql(`
      CREATE TABLE IF NOT EXISTS cf_agents_task_runs (${RUNS_COLUMNS}) WITHOUT ROWID`);
    // No (state, next_at) index: every claim, refresh, and settle rewrites
    // next_at, and Cloudflare bills each touched index as a row written —
    // a per-write tax on the hottest run mutations, paid to accelerate the
    // startup reconcile's one scan of a retention-bounded table. The
    // definition index stays: list-by-definition reads scale with retained
    // runs, and definition/created_at never change after insert.
    rawSql(`
      CREATE INDEX IF NOT EXISTS cf_agents_task_runs_definition
      ON cf_agents_task_runs (definition, created_at)
    `);
    // Partial: a run without a key (most of them) writes no entry here.
    rawSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS cf_agents_task_runs_idempotency_key
      ON cf_agents_task_runs (idempotency_key)
      WHERE idempotency_key IS NOT NULL
    `);
    // A lane's head and next run are read on every lane settle; only lane
    // runs carry an entry.
    rawSql(`
      CREATE INDEX IF NOT EXISTS cf_agents_task_runs_lane
      ON cf_agents_task_runs (lane, seq) WHERE lane IS NOT NULL
    `);
    rawSql(`
      CREATE TABLE IF NOT EXISTS cf_agents_task_steps (
        run_id TEXT NOT NULL,
        step_name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('do', 'sleep')),
        state TEXT NOT NULL CHECK (state IN (
          'running', 'waiting', 'completed', 'failed'
        )),
        result TEXT,
        error_name TEXT,
        error_message TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        PRIMARY KEY (run_id, step_name)
      ) WITHOUT ROWID`);
    rawSql(`
      CREATE TABLE IF NOT EXISTS cf_agents_task_parts (
        run_id TEXT NOT NULL,
        piece INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (run_id, piece)
      ) WITHOUT ROWID`);
    rawSql(`
      CREATE TABLE IF NOT EXISTS cf_agents_task_checkpoint (
        run_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (run_id, key)
      ) WITHOUT ROWID`);
  }

  rowToRecord(row: TaskRunRow): TaskRecord {
    return {
      runId: row.run_id,
      definition: row.definition,
      status: row.status,
      attempt: row.attempt,
      ...(row.idempotency_key !== null && {
        idempotencyKey: row.idempotency_key
      }),
      ...(row.metadata !== null && {
        metadata: JSON.parse(row.metadata) as Record<string, TaskJson>
      }),
      ...(row.status === "pending" &&
        row.wait_reason !== null && { waitReason: row.wait_reason }),
      ...(row.status === "completed" && {
        result: deserializeTaskValue(row.result) as TaskValue
      }),
      ...(row.status === "error" && {
        error: {
          name: row.error_name ?? "Error",
          message: row.error_message ?? "Task run failed"
        }
      }),
      ...(row.cancel_reason !== null && { reason: row.cancel_reason }),
      createdAt: row.created_at,
      ...(row.started_at !== null && { startedAt: row.started_at }),
      ...(row.settled_at !== null && { settledAt: row.settled_at })
    };
  }

  rowToSnapshot<Output extends TaskValue>(
    row: TaskRunRow
  ): TaskRunSnapshot<Output> {
    const metadata =
      row.metadata !== null
        ? (JSON.parse(row.metadata) as Record<string, TaskJson>)
        : undefined;
    const base = {
      runId: row.run_id,
      definition: row.definition,
      createdAt: row.created_at,
      ...(metadata !== undefined ? { metadata } : {})
    };
    switch (row.status) {
      case "pending":
        return {
          ...base,
          status: "pending",
          ...(row.wait_reason !== null
            ? {
                waitReason: row.wait_reason,
                wakeAt: row.next_at ?? row.updated_at
              }
            : {}),
          ...(row.status_message !== null
            ? { statusMessage: row.status_message }
            : {})
        };
      case "running":
        return {
          ...base,
          status: "running",
          attempt: row.attempt,
          startedAt: row.started_at ?? row.created_at,
          ...(row.status_message !== null
            ? { statusMessage: row.status_message }
            : {})
        };
      case "completed":
        return {
          ...base,
          status: "completed",
          result: deserializeTaskValue(row.result) as Output,
          settledAt: row.settled_at ?? row.updated_at
        };
      case "error":
        return {
          ...base,
          status: "error",
          error: {
            name: row.error_name ?? "Error",
            message: row.error_message ?? "Task run failed"
          },
          settledAt: row.settled_at ?? row.updated_at
        };
      case "aborted":
        return {
          ...base,
          status: "aborted",
          ...(row.cancel_reason !== null ? { reason: row.cancel_reason } : {}),
          settledAt: row.settled_at ?? row.updated_at
        };
      case "skipped":
        return {
          ...base,
          status: "skipped",
          ...(row.cancel_reason !== null ? { reason: row.cancel_reason } : {}),
          settledAt: row.settled_at ?? row.updated_at
        };
    }
  }
}
