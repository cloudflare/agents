/**
 * Storage layer for the Tasks capability: owns the `cf_agents_task_runs` and
 * `cf_agents_task_steps` tables — DDL, row access, generation-fenced writes,
 * and the snapshot projection. The engine in `tasks.ts` holds the state
 * machine; every byte that touches SQLite goes through here.
 */

import { SqlError } from "../sql-error";
import { deserializeTaskValue } from "./serialization";
import type { TaskJson, TaskRunRow, TaskRunSnapshot, TaskValue } from "./types";

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
    this.sql`DELETE FROM cf_agents_task_steps WHERE run_id = ${runId}`;
    this.sql`DELETE FROM cf_agents_task_runs WHERE run_id = ${runId}`;
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
      )
    `);
    rawSql(`
      CREATE INDEX IF NOT EXISTS cf_agents_task_runs_due
      ON cf_agents_task_runs (state, next_at)
    `);
    rawSql(`
      CREATE INDEX IF NOT EXISTS cf_agents_task_runs_definition
      ON cf_agents_task_runs (definition, created_at)
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
      )
    `);
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
        return {
          ...base,
          state: "waiting",
          reason: row.wait_reason ?? "sleep",
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
}
