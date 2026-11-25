/**
 * The step-engine port: the storage-side operations `ReplayStep` drives —
 * journal reads and writes, generation fencing, claim refresh, progress —
 * bound to one claimed attempt. `tasks.ts` owns the state machine; this
 * module owns nothing but the port's construction.
 */

import {
  AttemptSupersededError,
  TaskCancellation,
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
  /** When the attempt's claim write persisted its `next_at` backstop. */
  claimedAtMs: number;
  /**
   * Minimum wall time between claim writes. Sized to half the claim slack:
   * every claim write lands `step timeout + slack` ahead, so a refresh
   * skipped this recently still leaves a full step timeout plus half the
   * slack of headroom — no policy-respecting step can outlive the claim,
   * and a burst of fast steps pays zero claim-refresh row writes.
   */
  claimRefreshAfterMs: number;
  defaults: ResolvedStepPolicy;
  emit: (type: string, payload: Record<string, unknown>) => void;
};

/** @internal Build the engine port for one claimed attempt. */
export function createTaskStepEngine(deps: TaskStepEngineDeps): TaskStepEngine {
  const { runId, generation } = deps;
  const t = deps.store.tables;
  // The newest claim deadline known durable. The queue's own backstop push
  // (a due wake observing the live attempt) only ever moves `next_at`
  // forward, so this stays a conservative lower bound.
  let lastClaimWriteAt = deps.claimedAtMs;
  // The last status message known durable — persisting an identical one
  // again would be a pure row-write duplicate.
  let lastStatusMessage: string | undefined;
  // Every journal write carries the attempt's fence in its own statement
  // (no read of the run row first): a write that lands nothing means a
  // newer attempt owns the run.
  const OWNS = `EXISTS (SELECT 1 FROM ${t.runs}
                  WHERE run_id = ? AND generation = ?)`;
  const fenced = (query: string, params: (string | number | null)[]) => {
    if (deps.store.write(query, [...params, runId, generation]) === 0) {
      throw new AttemptSupersededError(runId);
    }
  };
  return {
    readStep: (name) => {
      const rows = deps.store.sql<TaskStepRow>`
          SELECT * FROM ${t.steps}
          WHERE run_id = ${runId} AND step_name = ${name}
        `;
      return rows[0];
    },
    countSteps: () => {
      const rows = deps.store.sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM ${t.steps} WHERE run_id = ${runId}
        `;
      return rows[0]?.count ?? 0;
    },
    insertStep: (name, kind, wakeAt) => {
      const now = Date.now();
      fenced(
        `INSERT INTO ${t.steps}
           (run_id, step_name, kind, state, attempt, next_at, created_at,
            started_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${OWNS}`,
        [
          runId,
          name,
          kind,
          kind === "do" ? "running" : wakeAt === null ? "running" : "waiting",
          kind === "do" ? 1 : 0,
          wakeAt,
          now,
          kind === "do" ? now : null,
          now
        ]
      );
    },
    insertCompletedSleep: (name) => {
      const now = Date.now();
      // An already-elapsed sleep is journaled born-completed: one INSERT,
      // where insert-then-complete would write the same row twice in the
      // same synchronous block (one durable commit either way, so the
      // split bought no crash evidence).
      fenced(
        `INSERT INTO ${t.steps}
           (run_id, step_name, kind, state, attempt, next_at, created_at,
            completed_at, updated_at)
         SELECT ?, ?, 'sleep', 'completed', 0, NULL, ?, ?, ? WHERE ${OWNS}`,
        [runId, name, now, now, now]
      );
    },
    claimStepAttempt: (name) => {
      const now = Date.now();
      const rows = deps.store.sql<{ attempt: number }>`
          UPDATE ${t.steps}
          SET state = 'running', attempt = attempt + 1, next_at = NULL,
              started_at = ${now}, updated_at = ${now}
          WHERE run_id = ${runId} AND step_name = ${name}
            AND EXISTS (SELECT 1 FROM ${t.runs}
                        WHERE run_id = ${runId} AND generation = ${generation})
          RETURNING attempt
        `;
      if (rows[0] === undefined) throw new AttemptSupersededError(runId);
      return rows[0].attempt;
    },
    completeStep: (name, result) => {
      const resultJson = serializeTaskValue(
        result,
        `result of step "${name}" in run "${runId}"`
      );
      const now = Date.now();
      fenced(
        `UPDATE ${t.steps}
         SET state = 'completed', result = ?, next_at = NULL,
             completed_at = ?, updated_at = ?
         WHERE run_id = ? AND step_name = ? AND ${OWNS}`,
        [resultJson, now, now, runId, name]
      );
    },
    failStep: (name, error) => {
      const now = Date.now();
      fenced(
        `UPDATE ${t.steps}
         SET state = 'failed', error_name = ?, error_message = ?,
             next_at = NULL, updated_at = ?
         WHERE run_id = ? AND step_name = ? AND ${OWNS}`,
        [error.name, error.message, now, runId, name]
      );
    },
    waitStep: (name, wakeAt) => {
      const now = Date.now();
      fenced(
        `UPDATE ${t.steps}
         SET state = 'waiting', next_at = ?, updated_at = ?
         WHERE run_id = ? AND step_name = ? AND ${OWNS}`,
        [wakeAt, now, runId, name]
      );
    },
    refreshClaim: () => {
      const now = Date.now();
      if (now - lastClaimWriteAt < deps.claimRefreshAfterMs) return;
      const written = deps.store.fencedWrite(
        runId,
        generation,
        `UPDATE ${t.runs} SET next_at = ?, updated_at = ?
           WHERE run_id = ? AND generation = ? AND status = 'running'`,
        [now + deps.claimTimeoutMs(), now]
      );
      if (written) lastClaimWriteAt = now;
    },
    writeStatus: (message) => {
      if (message === lastStatusMessage) return;
      const written = deps.store.fencedWrite(
        runId,
        generation,
        `UPDATE ${t.runs} SET status_message = ?, updated_at = ?
           WHERE run_id = ? AND generation = ? AND status = 'running'`,
        [message, Date.now()]
      );
      if (written) lastStatusMessage = message;
    },
    // A cancel (or a lane clear) settles the run and aborts this attempt's
    // signal with the reason: no read of the run row is needed to see it.
    cancellationRequested: () => {
      const reason: unknown = deps.signal.reason;
      if (!deps.signal.aborted || !(reason instanceof TaskCancellation)) {
        return null;
      }
      return { reason: reason.reason };
    },
    attemptSignal: deps.signal,
    emit: deps.emit,
    stepIdempotencyKey: (name) => `${runId}:${name}`,
    defaults: deps.defaults
  };
}
