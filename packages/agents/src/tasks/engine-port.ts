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
import { MAX_SERIALIZED_BYTES, serializeTaskValue } from "./serialization";
import type { TaskEvent, TaskEventRow, TaskStepRow } from "./types";
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
  // The newest claim deadline known durable. The queue's own backstop push
  // (a due wake observing the live attempt) only ever moves `next_at`
  // forward, so this stays a conservative lower bound.
  let lastClaimWriteAt = deps.claimedAtMs;
  // The last status message known durable — persisting an identical one
  // again would be a pure row-write duplicate.
  let lastStatusMessage: string | undefined;
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
    insertCompletedSleep: (name) => {
      assertCurrent();
      const now = Date.now();
      // An already-elapsed sleep is journaled born-completed: one INSERT,
      // where insert-then-complete would write the same row twice in the
      // same synchronous block (one durable commit either way, so the
      // split bought no crash evidence).
      deps.store.sql`
          INSERT INTO cf_agents_task_steps
            (run_id, step_name, kind, state, attempt, next_at, created_at,
             completed_at, updated_at)
          VALUES
            (${runId}, ${name}, 'sleep', 'completed', 0, NULL, ${now},
             ${now}, ${now})
        `;
    },
    consumeEventStep: (name, kind, type, limit, wakeAt) => {
      const outcome = deps.store.transaction<
        | { state: "waiting" }
        | { state: "completed"; result: TaskEvent | TaskEvent[] | null }
      >(() => {
        assertCurrent();
        const now = Date.now();
        const candidates =
          kind === "wait_event"
            ? deps.store.sql<TaskEventRow>`
                SELECT * FROM cf_agents_task_events
                WHERE run_id = ${runId} AND type = ${type}
                  AND consumed_at IS NULL
                ORDER BY sequence ASC
                LIMIT 1
              `
            : deps.store.sql<TaskEventRow>`
                WITH limited AS (
                  SELECT *
                  FROM cf_agents_task_events
                  WHERE run_id = ${runId} AND type = ${type}
                    AND consumed_at IS NULL
                  ORDER BY sequence ASC
                  LIMIT ${limit}
                ), candidates AS (
                  SELECT limited.*,
                    SUM(serialized_size + 1) OVER (
                      ORDER BY sequence ASC
                    ) AS cumulative_size
                  FROM limited
                )
                SELECT sequence, event_id, run_id, type, payload,
                       serialized_size, idempotency_key, consumed_step_name,
                       created_at, consumed_at
                FROM candidates
                WHERE cumulative_size <= ${MAX_SERIALIZED_BYTES - 1}
                ORDER BY sequence ASC
              `;
        const rows =
          kind === "wait_event" && wakeAt !== null
            ? candidates.filter((row) => row.created_at <= wakeAt)
            : candidates;
        const events = rows.map((row) => deps.store.rowToEvent(row));
        const timedOut =
          kind === "wait_event" && wakeAt !== null && wakeAt <= now;

        if (events.length === 0 && kind === "wait_event" && !timedOut) {
          const existing = deps.store.sql<{ present: number }>`
            SELECT 1 AS present FROM cf_agents_task_steps
            WHERE run_id = ${runId} AND step_name = ${name}
          `;
          if (existing.length === 0) {
            deps.store.sql`
              INSERT INTO cf_agents_task_steps
                (run_id, step_name, kind, state, attempt, next_at, event_type,
                 created_at, updated_at)
              VALUES
                (${runId}, ${name}, 'wait_event', 'waiting', 0, ${wakeAt},
                 ${type}, ${now}, ${now})
            `;
          }
          return { state: "waiting" };
        }

        for (const row of rows) {
          deps.store.sql`
            UPDATE cf_agents_task_events
            SET consumed_step_name = ${name}, consumed_at = ${now}
            WHERE sequence = ${row.sequence} AND consumed_at IS NULL
          `;
        }
        const result = kind === "take_events" ? events : (events[0] ?? null);
        const resultJson = serializeTaskValue(
          result,
          `result of event step "${name}" in run "${runId}"`
        );
        const existing = deps.store.sql<{ present: number }>`
          SELECT 1 AS present FROM cf_agents_task_steps
          WHERE run_id = ${runId} AND step_name = ${name}
        `;
        if (existing.length === 0) {
          deps.store.sql`
            INSERT INTO cf_agents_task_steps
              (run_id, step_name, kind, state, result, attempt, next_at,
               event_type, created_at, completed_at, updated_at)
            VALUES
              (${runId}, ${name}, ${kind}, 'completed', ${resultJson}, 0, NULL,
               ${type}, ${now}, ${now}, ${now})
          `;
        } else {
          deps.store.sql`
            UPDATE cf_agents_task_steps
            SET state = 'completed', result = ${resultJson}, next_at = NULL,
                completed_at = ${now}, updated_at = ${now}
            WHERE run_id = ${runId} AND step_name = ${name}
          `;
        }
        return { state: "completed", result };
      });
      if (outcome.state === "completed") {
        const consumedEvents = Array.isArray(outcome.result)
          ? outcome.result
          : outcome.result === null
            ? []
            : [outcome.result];
        if (consumedEvents.length > 0) {
          deps.emit("task:event:consumed", {
            step: name,
            type,
            count: consumedEvents.length,
            eventIds: consumedEvents.map((event) => event.eventId)
          });
        }
      }
      return outcome;
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
      const now = Date.now();
      if (now - lastClaimWriteAt < deps.claimRefreshAfterMs) return;
      const written = deps.store.fencedWrite(
        runId,
        generation,
        `UPDATE cf_agents_task_runs SET next_at = ?, updated_at = ?
           WHERE run_id = ? AND generation = ? AND state = 'running'`,
        [now + deps.claimTimeoutMs(), now]
      );
      if (written) lastClaimWriteAt = now;
    },
    writeStatus: (message) => {
      if (message === lastStatusMessage) return;
      const written = deps.store.fencedWrite(
        runId,
        generation,
        `UPDATE cf_agents_task_runs SET status_message = ?, updated_at = ?
           WHERE run_id = ? AND generation = ? AND state = 'running'`,
        [message, Date.now()]
      );
      if (written) lastStatusMessage = message;
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
