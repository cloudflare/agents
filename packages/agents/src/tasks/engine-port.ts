/**
 * The step-engine port: the storage-side operations `ReplayStep` drives —
 * journal reads and writes, generation fencing, claim refresh, progress —
 * bound to one claimed attempt. `tasks.ts` owns the state machine; this
 * module owns nothing but the port's construction.
 */

import {
  AttemptSupersededError,
  type TaskStepEngine,
  type ResolvedStepPolicy
} from "./replay";
import { serializeTaskValue } from "./serialization";
import type { TaskStepRow } from "./types";
import type { TaskStore } from "./store";

/** @internal What one step engine needs from its owning capability. */
export type TaskStepEngineDeps = {
  store: TaskStore;
  runId: string;
  generation: string;
  signal: AbortSignal;
  claimTimeoutMs: () => number;
  defaults: ResolvedStepPolicy;
  emit: (type: string, payload: Record<string, unknown>) => void;
};

/** @internal Build the engine port for one claimed attempt. */
export function createTaskStepEngine(deps: TaskStepEngineDeps): TaskStepEngine {
  const { runId, generation } = deps;
  const assertCurrent = (): void => {
    const row = deps.store.getRun(runId);
    if (!row || row.generation !== generation) {
      throw new AttemptSupersededError(runId);
    }
  };
  return {
    readStep: (name) => {
      const rows = deps.store.sql<TaskStepRow>`
          SELECT * FROM cf_agents_task_steps
          WHERE run_id = ${runId} AND step_name = ${name}
        `;
      return rows[0];
    },
    countSteps: () => {
      const rows = deps.store.sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM cf_agents_task_steps WHERE run_id = ${runId}
        `;
      return rows[0]?.count ?? 0;
    },
    insertStep: (name, kind, wakeAt) => {
      assertCurrent();
      const now = Date.now();
      deps.store.sql`
          INSERT INTO cf_agents_task_steps
            (run_id, step_name, kind, state, attempt, next_at, created_at,
             started_at, updated_at)
          VALUES
            (${runId}, ${name}, ${kind},
             ${kind === "do" ? "running" : wakeAt === null ? "running" : "waiting"},
             ${kind === "do" ? 1 : 0}, ${wakeAt},
             ${now}, ${kind === "do" ? now : null}, ${now})
        `;
    },
    claimStepAttempt: (name) => {
      assertCurrent();
      const now = Date.now();
      deps.store.sql`
          UPDATE cf_agents_task_steps
          SET state = 'running', attempt = attempt + 1, next_at = NULL,
              started_at = ${now}, updated_at = ${now}
          WHERE run_id = ${runId} AND step_name = ${name}
        `;
      const rows = deps.store.sql<{ attempt: number }>`
          SELECT attempt FROM cf_agents_task_steps
          WHERE run_id = ${runId} AND step_name = ${name}
        `;
      return rows[0]?.attempt ?? 1;
    },
    completeStep: (name, result) => {
      assertCurrent();
      const resultJson = serializeTaskValue(
        result,
        `result of step "${name}" in run "${runId}"`
      );
      const now = Date.now();
      deps.store.sql`
          UPDATE cf_agents_task_steps
          SET state = 'completed', result = ${resultJson}, next_at = NULL,
              completed_at = ${now}, updated_at = ${now}
          WHERE run_id = ${runId} AND step_name = ${name}
        `;
    },
    failStep: (name, error) => {
      assertCurrent();
      const now = Date.now();
      deps.store.sql`
          UPDATE cf_agents_task_steps
          SET state = 'failed', error_name = ${error.name},
              error_message = ${error.message}, next_at = NULL, updated_at = ${now}
          WHERE run_id = ${runId} AND step_name = ${name}
        `;
    },
    waitStep: (name, wakeAt) => {
      assertCurrent();
      const now = Date.now();
      deps.store.sql`
          UPDATE cf_agents_task_steps
          SET state = 'waiting', next_at = ${wakeAt}, updated_at = ${now}
          WHERE run_id = ${runId} AND step_name = ${name}
        `;
    },
    refreshClaim: () => {
      deps.store.fencedWrite(
        runId,
        generation,
        `UPDATE cf_agents_task_runs SET next_at = ?, updated_at = ?
           WHERE run_id = ? AND generation = ? AND state = 'running'`,
        [Date.now() + deps.claimTimeoutMs(), Date.now()]
      );
    },
    writeStatus: (message) => {
      deps.store.fencedWrite(
        runId,
        generation,
        `UPDATE cf_agents_task_runs SET status_message = ?, updated_at = ?
           WHERE run_id = ? AND generation = ? AND state = 'running'`,
        [message, Date.now()]
      );
    },
    cancellationRequested: () => {
      const row = deps.store.getRun(runId);
      if (!row || row.cancel_requested !== 1) return null;
      return { reason: row.cancel_reason ?? undefined };
    },
    attemptSignal: deps.signal,
    emit: deps.emit,
    stepIdempotencyKey: (name) => `${runId}:${name}`,
    defaults: deps.defaults
  };
}
