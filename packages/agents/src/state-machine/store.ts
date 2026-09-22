import { SqlError } from "../sql-error";
import { deserializeMachineValue } from "./serialization";
import type {
  MachineChildRow,
  MachineChildView,
  MachineEffectRow,
  MachineEffectView,
  MachineEventRow,
  MachineGateRow,
  MachineGateView,
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
    this.createRunTable();
    this.ensureCoordinationTables();
  }

  createRunTable(): void {
    this.sql(`CREATE TABLE IF NOT EXISTS cf_agents_state_machine_runs (
      run_id TEXT PRIMARY KEY,
      definition TEXT NOT NULL,
      definition_version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled'
      )),
      phase TEXT,
      checkpoint_json TEXT,
      revision INTEGER NOT NULL,
      control_json TEXT NOT NULL,
      job_id TEXT,
      wait_kind TEXT,
      wait_type TEXT,
      wait_key TEXT,
      next_at INTEGER,
      event_sequence INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      cancel_reason TEXT,
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

  ensureCoordinationTables(): void {
    this.sql(`CREATE TABLE IF NOT EXISTS cf_agents_state_machine_events (
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      type TEXT NOT NULL,
      event_key TEXT,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      consumed_revision INTEGER,
      consumed_at INTEGER,
      PRIMARY KEY (run_id, event_id),
      UNIQUE (run_id, sequence)
    ) WITHOUT ROWID`);
    this.sql(`CREATE INDEX IF NOT EXISTS cf_agents_state_machine_event_match
      ON cf_agents_state_machine_events
        (run_id, type, event_key, consumed_at, sequence)`);

    this.sql(`CREATE TABLE IF NOT EXISTS cf_agents_state_machine_gates (
      gate_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      request_json TEXT NOT NULL,
      metadata_json TEXT,
      state TEXT NOT NULL CHECK (state IN (
        'open', 'answered', 'expired', 'withdrawn', 'cancelled'
      )),
      expires_at INTEGER NOT NULL,
      decision_event_id TEXT,
      created_at INTEGER NOT NULL,
      settled_at INTEGER
    ) WITHOUT ROWID`);
    this.sql(`CREATE INDEX IF NOT EXISTS cf_agents_state_machine_gate_run
      ON cf_agents_state_machine_gates (run_id, state, created_at)`);

    this.sql(`CREATE TABLE IF NOT EXISTS cf_agents_state_machine_effects (
      run_id TEXT NOT NULL,
      effect_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      kind TEXT NOT NULL,
      recovery TEXT NOT NULL CHECK (recovery IN ('safe', 'never', 'reconcile')),
      status TEXT NOT NULL CHECK (status IN (
        'pending', 'running', 'completed', 'failed', 'interrupted'
      )),
      input_json TEXT NOT NULL,
      external_id TEXT,
      result_json TEXT,
      error_name TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      settled_at INTEGER,
      PRIMARY KEY (run_id, effect_id)
    ) WITHOUT ROWID`);

    this.sql(`CREATE TABLE IF NOT EXISTS cf_agents_state_machine_children (
      parent_run_id TEXT NOT NULL,
      child_run_id TEXT NOT NULL,
      child_definition TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('attached', 'background')),
      status TEXT NOT NULL CHECK (status IN (
        'running', 'completed', 'failed', 'cancelled'
      )),
      completion_event_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      settled_at INTEGER,
      PRIMARY KEY (parent_run_id, child_run_id)
    ) WITHOUT ROWID`);
    this.sql(`CREATE INDEX IF NOT EXISTS cf_agents_state_machine_child_run
      ON cf_agents_state_machine_children (child_run_id)`);
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
         checkpoint_json, revision, control_json, job_id, wait_kind, wait_type,
         wait_key, next_at, event_sequence, cancel_requested, cancel_reason,
         result_json, error_name, error_message, retain, idempotency_key,
         created_at, updated_at, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.run_id,
      row.definition,
      row.definition_version,
      row.status,
      row.phase,
      row.checkpoint_json,
      row.revision,
      row.control_json,
      row.job_id,
      row.wait_kind,
      row.wait_type,
      row.wait_key,
      row.next_at,
      row.event_sequence,
      row.cancel_requested,
      row.cancel_reason,
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

  listOpen(): MachineRunRow[] {
    return this.sql<MachineRunRow>(
      `SELECT * FROM cf_agents_state_machine_runs
       WHERE status IN ('running', 'waiting')`
    );
  }

  nextEventSequence(runId: string): number {
    const row = this.sql<{ sequence: number }>(
      `UPDATE cf_agents_state_machine_runs
       SET event_sequence = event_sequence + 1
       WHERE run_id = ?
       RETURNING event_sequence - 1 AS sequence`,
      runId
    )[0];
    if (!row) throw new Error(`Machine run "${runId}" no longer exists`);
    return row.sequence;
  }

  getEvent(runId: string, eventId: string): MachineEventRow | undefined {
    return this.sql<MachineEventRow>(
      `SELECT * FROM cf_agents_state_machine_events
       WHERE run_id = ? AND event_id = ?`,
      runId,
      eventId
    )[0];
  }

  matchingEvents(
    runId: string,
    type: string,
    key: string | undefined,
    now: number
  ): MachineEventRow[] {
    const keyClause = key === undefined ? "" : " AND event_key = ?";
    const params: (string | number | null)[] = [runId, type];
    if (key !== undefined) params.push(key);
    params.push(now);
    return this.sql<MachineEventRow>(
      `SELECT * FROM cf_agents_state_machine_events
       WHERE run_id = ? AND type = ?${keyClause}
         AND consumed_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY sequence LIMIT 100`,
      ...params
    );
  }

  consumeEvents(
    runId: string,
    eventIds: readonly string[],
    revision: number,
    now: number
  ): void {
    for (const eventId of eventIds) {
      const written = this.write(
        `UPDATE cf_agents_state_machine_events
         SET consumed_revision = ?, consumed_at = ?
         WHERE run_id = ? AND event_id = ? AND consumed_at IS NULL`,
        [revision, now, runId, eventId]
      );
      if (written === 0) {
        throw new Error(`Machine event "${eventId}" is no longer available`);
      }
    }
  }

  getGate(gateId: string): MachineGateRow | undefined {
    return this.sql<MachineGateRow>(
      "SELECT * FROM cf_agents_state_machine_gates WHERE gate_id = ?",
      gateId
    )[0];
  }

  gatesForRun(runId: string): MachineGateRow[] {
    return this.sql<MachineGateRow>(
      `SELECT * FROM cf_agents_state_machine_gates
       WHERE run_id = ? ORDER BY created_at`,
      runId
    );
  }

  getEffect(runId: string, effectId: string): MachineEffectRow | undefined {
    return this.sql<MachineEffectRow>(
      `SELECT * FROM cf_agents_state_machine_effects
       WHERE run_id = ? AND effect_id = ?`,
      runId,
      effectId
    )[0];
  }

  effectsForRun(runId: string): MachineEffectRow[] {
    return this.sql<MachineEffectRow>(
      `SELECT * FROM cf_agents_state_machine_effects
       WHERE run_id = ? ORDER BY created_at`,
      runId
    );
  }

  childrenForRun(runId: string): MachineChildRow[] {
    return this.sql<MachineChildRow>(
      `SELECT * FROM cf_agents_state_machine_children
       WHERE parent_run_id = ? ORDER BY created_at`,
      runId
    );
  }

  parentRelations(childRunId: string): MachineChildRow[] {
    return this.sql<MachineChildRow>(
      `SELECT * FROM cf_agents_state_machine_children
       WHERE child_run_id = ?`,
      childRunId
    );
  }

  deleteOwnedRows(runId: string): void {
    this.sql(
      "DELETE FROM cf_agents_state_machine_events WHERE run_id = ?",
      runId
    );
    this.sql(
      "DELETE FROM cf_agents_state_machine_gates WHERE run_id = ?",
      runId
    );
    this.sql(
      "DELETE FROM cf_agents_state_machine_effects WHERE run_id = ?",
      runId
    );
    this.sql(
      "DELETE FROM cf_agents_state_machine_children WHERE parent_run_id = ?",
      runId
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
    if (
      row.status === "running" ||
      row.status === "waiting" ||
      row.status === "paused"
    ) {
      const gates = this.gatesForRun(row.run_id).map<MachineGateView>(
        (gate) => ({
          gateId: gate.gate_id,
          kind: gate.kind,
          ...(gate.metadata_json
            ? { metadata: JSON.parse(gate.metadata_json) }
            : {}),
          state: gate.state,
          expiresAt: gate.expires_at
        })
      );
      const effects = this.effectsForRun(row.run_id).map<MachineEffectView>(
        (effect) => ({
          effectId: effect.effect_id,
          kind: effect.kind,
          recovery: effect.recovery,
          status: effect.status,
          ...(effect.external_id ? { externalId: effect.external_id } : {})
        })
      );
      const children = this.childrenForRun(row.run_id).map<MachineChildView>(
        (child) => ({
          runId: child.child_run_id,
          definition: child.child_definition,
          mode: child.mode,
          status: child.status
        })
      );
      return {
        ...base,
        status: row.status,
        state: deserializeMachineValue(row.checkpoint_json) as State,
        ...(row.wait_kind && row.wait_type
          ? {
              wait: {
                kind: row.wait_kind,
                type: row.wait_type,
                ...(row.wait_key ? { key: row.wait_key } : {}),
                ...(row.next_at ? { timeoutAt: row.next_at } : {})
              }
            }
          : {}),
        ...(gates.length > 0 ? { gates } : {}),
        ...(effects.length > 0 ? { effects } : {}),
        ...(children.length > 0 ? { children } : {})
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
      status: row.status,
      error: {
        name:
          row.error_name ??
          (row.status === "cancelled" ? "Cancelled" : "Error"),
        message:
          row.error_message ??
          (row.status === "cancelled"
            ? "Machine run cancelled"
            : "Machine run failed")
      },
      settledAt: row.settled_at ?? row.updated_at
    };
  }
}
