import { SqlError } from "../sql-error";
import { deserializeMachineValue } from "./serialization";
import type {
  MachinePhased,
  MachineRunRow,
  MachineRunSnapshot,
  MachineValue
} from "./types";

export class StateMachineStore {
  constructor(readonly storage: DurableObjectStorage) {}

  transaction<T>(callback: () => T): T {
    return this.storage.transactionSync(callback);
  }

  sql<T = Record<string, string | number | null>>(
    query: string,
    ...params: (string | number | null)[]
  ): T[] {
    try {
      return [...this.storage.sql.exec(query, ...params)] as T[];
    } catch (cause) {
      throw new SqlError(query, cause);
    }
  }

  write(query: string, params: (string | number | null)[]): number {
    try {
      return this.storage.sql.exec(query, ...params).rowsWritten;
    } catch (cause) {
      throw new SqlError(query, cause);
    }
  }

  ensureTables(): void {
    this.sql(`CREATE TABLE IF NOT EXISTS cf_agents_state_machine_runs (
      run_id TEXT PRIMARY KEY,
      definition TEXT NOT NULL,
      definition_version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      phase TEXT,
      checkpoint_json TEXT,
      revision INTEGER NOT NULL,
      control_json TEXT NOT NULL,
      job_id TEXT,
      result_json TEXT,
      error_name TEXT,
      error_message TEXT,
      retain INTEGER NOT NULL DEFAULT 1,
      idempotency_key TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      settled_at INTEGER
    ) WITHOUT ROWID`);
    this.sql(`CREATE INDEX IF NOT EXISTS cf_agents_state_machine_definition
      ON cf_agents_state_machine_runs (definition, created_at)`);
  }

  getRun(runId: string): MachineRunRow | undefined {
    return this.sql<MachineRunRow>(
      "SELECT * FROM cf_agents_state_machine_runs WHERE run_id = ?",
      runId
    )[0];
  }

  getRunByKey(idempotencyKey: string): MachineRunRow | undefined {
    return this.sql<MachineRunRow>(
      "SELECT * FROM cf_agents_state_machine_runs WHERE idempotency_key = ?",
      idempotencyKey
    )[0];
  }

  insertRun(row: MachineRunRow): void {
    this.sql(
      `INSERT INTO cf_agents_state_machine_runs
        (run_id, definition, definition_version, status, phase,
         checkpoint_json, revision, control_json, job_id, result_json,
         error_name, error_message, retain, idempotency_key, created_at,
         updated_at, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.run_id,
      row.definition,
      row.definition_version,
      row.status,
      row.phase,
      row.checkpoint_json,
      row.revision,
      row.control_json,
      row.job_id,
      row.result_json,
      row.error_name,
      row.error_message,
      row.retain,
      row.idempotency_key,
      row.created_at,
      row.updated_at,
      row.settled_at
    );
  }

  listRunning(): MachineRunRow[] {
    return this.sql<MachineRunRow>(
      "SELECT * FROM cf_agents_state_machine_runs WHERE status = 'running'"
    );
  }

  toSnapshot<State extends MachinePhased, Result extends MachineValue>(
    row: MachineRunRow
  ): MachineRunSnapshot<State, Result> {
    const base = {
      runId: row.run_id,
      definition: row.definition,
      definitionVersion: row.definition_version,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
    if (row.status === "running") {
      return {
        ...base,
        status: "running",
        state: deserializeMachineValue(row.checkpoint_json) as State
      };
    }
    if (row.status === "completed") {
      return {
        ...base,
        status: "completed",
        result: deserializeMachineValue(row.result_json) as Result,
        settledAt: row.settled_at ?? row.updated_at
      };
    }
    return {
      ...base,
      status: "failed",
      error: {
        name: row.error_name ?? "Error",
        message: row.error_message ?? "Machine run failed"
      },
      settledAt: row.settled_at ?? row.updated_at
    };
  }
}
