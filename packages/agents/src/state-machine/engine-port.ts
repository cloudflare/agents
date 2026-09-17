/**
 * The engine port: the storage-side operations one claimed attempt drives —
 * turn-scoped journal reads and writes, generation fencing, claim refresh,
 * the mailbox and ask tables, run-scoped memos, the checkpoint commit, and
 * progress — bound to one claimed attempt. `tasks.ts` owns the state
 * machine; this module owns nothing but the port's construction.
 */

import {
  AttemptSupersededError,
  type TaskStepEngine,
  type ResolvedStepPolicy
} from "./replay";
import { taskIdempotencyKey } from "./machine";
import { serializeTaskValue } from "./serialization";
import type {
  TaskAskRow,
  TaskJournalRow,
  StateMachineMailboxFilter,
  TaskMailboxRow
} from "./types";
import type { TaskStore } from "./store";

/** Where run-scoped journal rows live; turn retirement never touches it. */
export const RUN_SCOPED_TURN = -1;

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
  /**
   * True when the definition is a durable function compiled onto the
   * engine. Its checkpoint never changes, so its journal scope is turn 0
   * forever and its idempotency keys omit the turn segment.
   */
  compiled: boolean;
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
  // Work the chunk log cannot see, credited in memory and stamped into the
  // next write that was happening anyway: nothing is written per credit.
  let creditedProgress = 0;
  const assertCurrent = (): void => {
    const row = deps.store.getRun(runId);
    if (!row || row.generation !== generation) {
      throw new AttemptSupersededError(runId);
    }
  };
  return {
    readStep: (turn, name) => {
      const rows = deps.store.sql<TaskJournalRow>`
          SELECT * FROM cf_agents_task_journal
          WHERE run_id = ${runId} AND turn = ${turn} AND name = ${name}
        `;
      return rows[0];
    },
    countSteps: (turn) => {
      const rows = deps.store.sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM cf_agents_task_journal
          WHERE run_id = ${runId} AND turn = ${turn}
        `;
      return rows[0]?.count ?? 0;
    },
    insertStep: (turn, name, kind, wakeAt) => {
      assertCurrent();
      const now = Date.now();
      deps.store.sql`
          INSERT INTO cf_agents_task_journal
            (run_id, turn, name, kind, state, attempt, next_at, created_at,
             started_at, updated_at)
          VALUES
            (${runId}, ${turn}, ${name}, ${kind},
             ${kind === "do" ? "running" : wakeAt === null ? "running" : "waiting"},
             ${kind === "do" ? 1 : 0}, ${wakeAt},
             ${now}, ${kind === "do" ? now : null}, ${now})
        `;
    },
    insertCompletedSleep: (turn, name) => {
      assertCurrent();
      const now = Date.now();
      // An already-elapsed sleep is journaled born-completed: one INSERT,
      // where insert-then-complete would write the same row twice in the
      // same synchronous block (one durable commit either way, so the
      // split bought no crash evidence).
      deps.store.sql`
          INSERT INTO cf_agents_task_journal
            (run_id, turn, name, kind, state, attempt, next_at, created_at,
             completed_at, updated_at)
          VALUES
            (${runId}, ${turn}, ${name}, 'sleep', 'completed', 0, NULL, ${now},
             ${now}, ${now})
        `;
    },
    claimStepAttempt: (turn, name) => {
      assertCurrent();
      const now = Date.now();
      deps.store.sql`
          UPDATE cf_agents_task_journal
          SET state = 'running', attempt = attempt + 1, next_at = NULL,
              started_at = ${now}, updated_at = ${now}
          WHERE run_id = ${runId} AND turn = ${turn} AND name = ${name}
        `;
      const rows = deps.store.sql<{ attempt: number }>`
          SELECT attempt FROM cf_agents_task_journal
          WHERE run_id = ${runId} AND turn = ${turn} AND name = ${name}
        `;
      return rows[0]?.attempt ?? 1;
    },
    completeStep: (turn, name, result) => {
      assertCurrent();
      const resultJson = serializeTaskValue(
        result,
        `result of step "${name}" in run "${runId}"`
      );
      const now = Date.now();
      deps.store.sql`
          UPDATE cf_agents_task_journal
          SET state = 'completed', result = ${resultJson}, next_at = NULL,
              completed_at = ${now}, updated_at = ${now}
          WHERE run_id = ${runId} AND turn = ${turn} AND name = ${name}
        `;
    },
    failStep: (turn, name, error) => {
      assertCurrent();
      const now = Date.now();
      deps.store.sql`
          UPDATE cf_agents_task_journal
          SET state = 'failed', error_name = ${error.name},
              error_message = ${error.message}, next_at = NULL, updated_at = ${now}
          WHERE run_id = ${runId} AND turn = ${turn} AND name = ${name}
        `;
    },
    waitStep: (turn, name, wakeAt) => {
      assertCurrent();
      const now = Date.now();
      deps.store.sql`
          UPDATE cf_agents_task_journal
          SET state = 'waiting', next_at = ${wakeAt}, updated_at = ${now}
          WHERE run_id = ${runId} AND turn = ${turn} AND name = ${name}
        `;
    },
    retireJournal: (turn) => {
      // Fenced like every other mutating method: a superseded attempt must
      // not delete the journal its successor is replaying against. The run
      // scope is never retired — its memos outlive every turn.
      assertCurrent();
      if (turn === RUN_SCOPED_TURN) return;
      deps.store.sql`
          DELETE FROM cf_agents_task_journal
          WHERE run_id = ${runId} AND turn = ${turn}
        `;
    },
    readMemo: (name) => {
      const rows = deps.store.sql<TaskJournalRow>`
          SELECT * FROM cf_agents_task_journal
          WHERE run_id = ${runId} AND turn = ${RUN_SCOPED_TURN}
            AND name = ${name}
        `;
      return rows[0];
    },
    writeMemo: (name, value) => {
      assertCurrent();
      const now = Date.now();
      // First writer wins: a repeat is zero rows and zero index writes, which
      // is what makes a memo safe to re-derive on every replay.
      return (
        deps.store.write(
          `INSERT INTO cf_agents_task_journal
             (run_id, turn, name, kind, state, result, attempt, created_at,
              updated_at, completed_at)
           VALUES (?, ?, ?, 'memo', 'completed', ?, 0, ?, ?, ?)
           ON CONFLICT (run_id, turn, name) DO NOTHING`,
          [runId, RUN_SCOPED_TURN, name, value, now, now, now]
        ) > 0
      );
    },
    peekMailbox: (filter, now) => {
      // FIFO order is applied in memory, not by `ORDER BY seq`: `seq` is not
      // part of the (run_id, key) primary key, so SQL ordering would build a
      // temp b-tree on top of the prefix range the key already gives.
      const rows = deps.store.sql<TaskMailboxRow>`
          SELECT * FROM cf_agents_task_mailbox
          WHERE run_id = ${runId}
            AND (visible_after IS NULL OR visible_after <= ${now})
        `;
      rows.sort((left, right) => left.seq - right.seq);
      return matchMailbox(rows, filter);
    },
    consumeMailbox: (keys) => {
      if (keys.length === 0) return 0;
      assertCurrent();
      const placeholders = keys.map(() => "?").join(", ");
      return deps.store.write(
        `DELETE FROM cf_agents_task_mailbox
         WHERE run_id = ? AND key IN (${placeholders})`,
        [runId, ...keys]
      );
    },
    countMailbox: () => {
      const rows = deps.store.sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM cf_agents_task_mailbox
          WHERE run_id = ${runId}
        `;
      return rows[0]?.count ?? 0;
    },
    nextMailboxSeq: () => {
      // Read and insert happen in one synchronous block, and a Durable
      // Object runs one at a time, so this cannot interleave. Reusing a low
      // seq after a full drain is harmless: seq is only ever compared within
      // the live set, and a new row always outranks every survivor.
      const rows = deps.store.sql<{ next: number }>`
          SELECT COALESCE(MAX(seq), -1) + 1 AS next
          FROM cf_agents_task_mailbox WHERE run_id = ${runId}
        `;
      return rows[0]?.next ?? 0;
    },
    appendMailbox: (item) => {
      const now = Date.now();
      // `requestId` dedupe IS this conflict clause: a duplicate writes zero
      // rows, reads nothing, and touches no index.
      return (
        deps.store.write(
          `INSERT INTO cf_agents_task_mailbox
             (run_id, key, seq, kind, type, payload, visible_after, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (run_id, key) DO NOTHING`,
          [
            runId,
            item.key,
            item.seq,
            item.kind,
            item.type,
            item.payload,
            item.visibleAfter,
            now
          ]
        ) > 0
      );
    },
    insertAsk: (ask) => {
      assertCurrent();
      const now = Date.now();
      deps.store.sql`
          INSERT INTO cf_agents_task_asks
            (ask_id, run_id, turn, name, question, answer, state, expires_at,
             metadata, created_at, answered_at)
          VALUES
            (${ask.askId}, ${runId}, ${ask.turn}, ${ask.name}, ${ask.question},
             NULL, 'open', ${ask.expiresAt}, ${ask.metadata}, ${now}, NULL)
        `;
    },
    readAsks: (askIds) => {
      if (askIds.length === 0) return [];
      const placeholders = askIds.map(() => "?").join(", ");
      // Scoped to the owner like `settleAsk` and `withdrawOpenAsks`: an ask
      // id is routable from anywhere and cannot be trusted to encode its own
      // run, so a forged or stale one must read nothing rather than another
      // run's row. The `ask_id` primary key still drives the lookup.
      return deps.store.read<TaskAskRow>(
        `SELECT * FROM cf_agents_task_asks
         WHERE run_id = ? AND ask_id IN (${placeholders})`,
        [runId, ...askIds]
      );
    },
    settleAsk: (askId, state, answer) => {
      const now = Date.now();
      // Conditional on `open`, so two isolates racing one answer apply it
      // exactly once and the loser reads `{ accepted: false }`.
      return (
        deps.store.write(
          `UPDATE cf_agents_task_asks
           SET state = ?, answer = ?, answered_at = ?
           WHERE ask_id = ? AND run_id = ? AND state = 'open'`,
          [state, answer, now, askId, runId]
        ) > 0
      );
    },
    withdrawOpenAsks: () => {
      // Settlement marks open asks withdrawn rather than deleting them: the
      // UI can still show what was asked and why it lapsed.
      return deps.store.write(
        `UPDATE cf_agents_task_asks SET state = 'withdrawn', answered_at = ?
         WHERE run_id = ? AND state = 'open'`,
        [Date.now(), runId]
      );
    },
    listChildren: () => deps.store.listChildren(runId),
    commitCheckpoint: (commit) => {
      const now = Date.now();
      const written = deps.store.fencedWrite(
        runId,
        generation,
        `UPDATE cf_agents_task_runs
         SET checkpoint = ?, checkpoint_turn = ?, transitions = ?, stall = ?,
             progress = ?, updated_at = ?
         WHERE run_id = ? AND generation = ? AND state = 'running'
           AND abort_mark IS NULL`,
        [
          commit.checkpoint,
          commit.turn,
          commit.transitions,
          commit.stall,
          commit.progress,
          now
        ]
      );
      if (!written) return false;
      // Retirement is turn-scoped by construction: the run scope holds the
      // memos a later turn still reads, so it is excluded here rather than
      // trusted to never be passed.
      if (commit.retireTurn !== null && commit.retireTurn !== RUN_SCOPED_TURN) {
        deps.store.sql`
            DELETE FROM cf_agents_task_journal
            WHERE run_id = ${runId} AND turn = ${commit.retireTurn}
          `;
      }
      return true;
    },
    creditProgress: (units) => {
      creditedProgress += units;
    },
    progressCredited: () => creditedProgress,
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
      // The abort mark is the barrier every checkpoint-advancing write is
      // fenced on, so it is also what a step boundary asks about; the
      // legacy `cancel_reason` is still written beside it.
      const row = deps.store.getRun(runId);
      if (!row || row.abort_mark !== "cancel") return null;
      return { reason: row.abort_reason ?? row.cancel_reason ?? undefined };
    },
    attemptSignal: deps.signal,
    emit: deps.emit,
    stepIdempotencyKey: (turn, name, scope) =>
      taskIdempotencyKey(runId, name, {
        turn,
        compiled: deps.compiled,
        ...(scope !== undefined ? { scope } : {})
      }),
    defaults: deps.defaults
  };
}

/** Apply one mailbox filter to a run's visible rows, in FIFO order. */
function matchMailbox(
  rows: readonly TaskMailboxRow[],
  filter: StateMachineMailboxFilter | undefined
): TaskMailboxRow[] {
  const matches = (row: TaskMailboxRow): boolean =>
    matchesOne(row.kind, filter?.kind) &&
    matchesOne(row.type, filter?.type) &&
    (filter?.key === undefined || row.key === filter.key);
  const matched = rows.filter(matches);
  return filter?.limit === undefined ? matched : matched.slice(0, filter.limit);
}

function matchesOne(
  value: string | null,
  wanted: string | readonly string[] | undefined
): boolean {
  if (wanted === undefined) return true;
  if (typeof wanted === "string") return value === wanted;
  return value !== null && wanted.includes(value);
}
