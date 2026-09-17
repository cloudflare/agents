/**
 * Storage layer for the Tasks capability: owns its run, step, and event
 * tables — DDL, row access, generation-fenced writes, and snapshot
 * projection. The engine in `tasks.ts` holds the state machine; every byte
 * that touches SQLite goes through here.
 */

import { SqlError } from "../sql-error";
import { deserializeTaskValue } from "./serialization";
import type {
  TaskEvent,
  TaskEventRow,
  TaskJson,
  TaskRunRow,
  TaskRunSnapshot,
  TaskValue
} from "./types";

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

  getRunByKey(idempotencyKey: string): TaskRunRow | undefined {
    const rows = this.sql<TaskRunRow>`
      SELECT * FROM cf_agents_task_runs WHERE idempotency_key = ${idempotencyKey}
    `;
    return rows[0];
  }

  deleteRun(runId: string): void {
    this.sql`DELETE FROM cf_agents_task_events WHERE run_id = ${runId}`;
    this.sql`DELETE FROM cf_agents_task_steps WHERE run_id = ${runId}`;
    this.sql`DELETE FROM cf_agents_task_runs WHERE run_id = ${runId}`;
  }

  /** Run crash-atomic synchronous SQLite work. */
  transaction<T>(callback: () => T): T {
    return this.#storage.transactionSync(callback);
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
      CREATE TABLE IF NOT EXISTS cf_agents_task_runs (
        run_id TEXT PRIMARY KEY,
        definition TEXT NOT NULL,
        input TEXT,
        state TEXT NOT NULL CHECK (state IN (
          'pending', 'running', 'waiting',
          'completed', 'failed', 'cancelled'
        )),
        result TEXT,
        error_name TEXT,
        error_message TEXT,
        status_message TEXT,
        metadata TEXT,
        idempotency_key TEXT UNIQUE,
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
        settled_at INTEGER
      ) WITHOUT ROWID`);
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
    rawSql(`
      CREATE TABLE IF NOT EXISTS cf_agents_task_steps (
        run_id TEXT NOT NULL,
        step_name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'do', 'sleep', 'wait_event', 'take_events'
        )),
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
        event_type TEXT,
        PRIMARY KEY (run_id, step_name)
      ) WITHOUT ROWID`);
    rawSql(`
      CREATE TABLE IF NOT EXISTS cf_agents_task_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        serialized_size INTEGER NOT NULL,
        idempotency_key TEXT,
        consumed_step_name TEXT,
        created_at INTEGER NOT NULL,
        consumed_at INTEGER,
        UNIQUE (run_id, idempotency_key)
      )`);
    rawSql(`
      CREATE INDEX IF NOT EXISTS cf_agents_task_events_available
      ON cf_agents_task_events (run_id, type, consumed_at, sequence)
    `);
  }

  /** Detect the durable step schema independently of the KV version marker. */
  stepSchemaVersion(): 0 | 1 | 2 {
    const table = this.sql<{ present: number }>`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'cf_agents_task_steps'
    `;
    if (table.length === 0) return 0;
    const columns = this.sql<{ name: string }>`
      PRAGMA table_info(cf_agents_task_steps)
    `;
    return columns.some((column) => column.name === "event_type") ? 2 : 1;
  }

  /** Upgrade the v1 step-kind constraint without changing journal rows. */
  migrateV1ToV2(): void {
    this.transaction(() => {
      this.sql`
        CREATE TABLE cf_agents_task_steps_v2 (
          run_id TEXT NOT NULL,
          step_name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN (
            'do', 'sleep', 'wait_event', 'take_events'
          )),
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
          event_type TEXT,
          PRIMARY KEY (run_id, step_name)
        ) WITHOUT ROWID
      `;
      this.sql`
        INSERT INTO cf_agents_task_steps_v2
          (run_id, step_name, kind, state, result, error_name, error_message,
           attempt, next_at, created_at, started_at, updated_at, completed_at)
        SELECT run_id, step_name, kind, state, result, error_name, error_message,
               attempt, next_at, created_at, started_at, updated_at, completed_at
        FROM cf_agents_task_steps
      `;
      this.sql`DROP TABLE cf_agents_task_steps`;
      this
        .sql`ALTER TABLE cf_agents_task_steps_v2 RENAME TO cf_agents_task_steps`;
    });
    this.ensureTables();
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
    switch (row.state) {
      case "pending":
        return { ...base, state: "pending" };
      case "running":
        return {
          ...base,
          state: "running",
          attempt: row.attempt,
          startedAt: row.started_at ?? row.created_at,
          ...(row.status_message !== null
            ? { statusMessage: row.status_message }
            : {})
        };
      case "waiting":
        if (row.wait_reason === "event") {
          return {
            ...base,
            state: "waiting",
            reason: "event",
            ...(row.next_at !== null ? { wakeAt: row.next_at } : {}),
            ...(row.status_message !== null
              ? { statusMessage: row.status_message }
              : {})
          };
        }
        return {
          ...base,
          state: "waiting",
          reason: row.wait_reason === "retry" ? "retry" : "sleep",
          wakeAt: row.next_at ?? row.updated_at,
          ...(row.status_message !== null
            ? { statusMessage: row.status_message }
            : {})
        };
      case "completed":
        return {
          ...base,
          state: "completed",
          result: deserializeTaskValue(row.result) as Output,
          settledAt: row.settled_at ?? row.updated_at
        };
      case "failed":
        return {
          ...base,
          state: "failed",
          error: {
            name: row.error_name ?? "Error",
            message: row.error_message ?? "Task run failed"
          },
          settledAt: row.settled_at ?? row.updated_at
        };
      case "cancelled":
        return {
          ...base,
          state: "cancelled",
          ...(row.cancel_reason !== null ? { reason: row.cancel_reason } : {}),
          settledAt: row.settled_at ?? row.updated_at
        };
    }
  }

  rowToEvent<Payload = TaskJson>(row: TaskEventRow): TaskEvent<Payload> {
    return {
      eventId: row.event_id,
      type: row.type,
      payload: deserializeTaskValue(row.payload) as Payload,
      createdAt: row.created_at
    };
  }
}
