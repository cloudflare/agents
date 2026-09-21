/**
 * Storage layer for the StateMachine capability: owns the `cf_agents_task_runs`,
 * `cf_agents_task_journal`, `cf_agents_task_mailbox`, `cf_agents_task_asks`
 * and `cf_agents_task_routes` tables — DDL, row access, generation-fenced
 * writes, and the snapshot and view projections. The engine in `tasks.ts`
 * holds the state machine; every byte that touches SQLite goes through here.
 */

import { SqlError } from "../sql-error";
import { childMailboxKey } from "./machine";
import { deserializeTaskValue } from "./serialization";
import type { LifecycleRouteAddress } from "../lifecycle/capability";
import type {
  StateMachineAskRecord,
  StateMachineAskState,
  TaskAskRow,
  StateMachineChildRef,
  StateMachineJson,
  StateMachineMailboxItem,
  TaskMailboxRow,
  TaskRunRow,
  StateMachineRunSnapshot,
  StateMachineRunView,
  StateMachineValue,
  TaskRouteRow
} from "./types";

/** Rows one journal-rebuild transaction copies. */
export const JOURNAL_REBUILD_BATCH = 2_000;

/**
 * Retained step rows above which the rebuild logs one warning: the copy is
 * one write per row, and a ledger this size is evidence that
 * `tasks.delete({ settledBefore })` was never called.
 */
export const JOURNAL_REBUILD_WARN_ROWS = 10_000;

/** How far a journal rebuild has copied: the last `(run_id, name)` moved. */
export type TaskJournalCursor = {
  readonly runId: string;
  readonly name: string;
};

/** The cursor a fresh rebuild starts from; every real run id sorts above it. */
export const JOURNAL_REBUILD_START: TaskJournalCursor = { runId: "", name: "" };

/**
 * Derive `definition_base` / `definition_version` from `definition` in SQL:
 * strip trailing digits, and treat what is left as a version only when it
 * ends `@v`, leaves a non-empty base, and the digits parse above zero. That
 * is the same rule `parseDefinitionName` applies in TypeScript, so the
 * backfill and every later insert agree.
 */
const VERSIONED_DEFINITION = `
  rtrim(definition, '0123456789') <> definition
  AND substr(rtrim(definition, '0123456789'), -2) = '@v'
  AND length(rtrim(definition, '0123456789')) > 2
  AND CAST(substr(definition, length(rtrim(definition, '0123456789')) + 1) AS INTEGER) > 0`;

/** @internal SQL-backed store for one StateMachine capability instance. */
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
      // SAFETY: StateMachine queries select from its own schema; T describes the
      // projected columns of the accompanying query text.
      return [...this.#storage.sql.exec(query, ...values)] as T[];
    } catch (cause) {
      throw new SqlError(query, cause);
    }
  }

  /** Read with positional parameters, where a template literal will not do. */
  read<T>(query: string, params: (string | number | null)[]): T[] {
    try {
      // SAFETY: StateMachine queries select from its own schema; T describes the
      // projected columns of the accompanying query text.
      return [...this.#storage.sql.exec(query, ...params)] as T[];
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

  /** Run one closure inside a single SQLite transaction. */
  transactionSync<T>(closure: () => T): T {
    return this.#storage.transactionSync(closure);
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

  /**
   * Remove one run and everything it owns, in one synchronous block: its
   * journal, its mailbox, its asks, its routed-owner row, the settlement
   * note it left in its parent's mailbox, and the run row itself. Every path
   * that removes a run — a `retain:false` settle, `tasks.delete()`, the
   * sealing purge, a facet subtree teardown — goes through here, so none of
   * them can leave an orphan row behind.
   *
   * `keepParentNote` is the one release that must not take the note with it:
   * a `retain:false` run has just delivered its outcome to a parent that has
   * yet to read it, so the note is the run's result rather than a leftover.
   * Every other path deletes a note nobody is waiting on.
   */
  deleteRun(runId: string, options: { keepParentNote?: boolean } = {}): void {
    // The parent, read before the run row goes, so the note this run left in
    // its parent's mailbox can be removed by primary key rather than by a
    // scan. One narrow read on a delete path, against a whole-table scan on
    // every settle of every run.
    const parent =
      options.keepParentNote === true ? null : this.#parentOf(runId);
    this.sql`DELETE FROM cf_agents_task_journal WHERE run_id = ${runId}`;
    this.sql`DELETE FROM cf_agents_task_mailbox WHERE run_id = ${runId}`;
    // By `run_id`, not by the `ask_id` prefix: a run id is caller-chosen and
    // may itself contain '#', so a prefix range could reach another run's
    // asks. That rules out the prefix scan §4.4 assumed, and the alternative
    // — a `run_id` index — would tax every ask INSERT with an index write to
    // speed up a delete path and one view read. The scan stays; ordering
    // moves to memory so it does not also build a temp b-tree.
    this.sql`DELETE FROM cf_agents_task_asks WHERE run_id = ${runId}`;
    // Its own route row, and the rows for children it spawned elsewhere.
    this.sql`
      DELETE FROM cf_agents_task_routes
      WHERE run_id = ${runId} OR parent_run_id = ${runId}
    `;
    if (parent !== null) {
      this.write(
        `DELETE FROM cf_agents_task_mailbox WHERE run_id = ? AND key = ?`,
        [parent, childMailboxKey(runId)]
      );
    }
    this.sql`DELETE FROM cf_agents_task_runs WHERE run_id = ${runId}`;
  }

  /** The run that owns this one, or null when it is top-level or gone. */
  #parentOf(runId: string): string | null {
    const rows = this.sql<{ parent_run_id: string | null }>`
      SELECT parent_run_id FROM cf_agents_task_runs WHERE run_id = ${runId}
    `;
    return rows[0]?.parent_run_id ?? null;
  }

  #rawSql(query: string): void {
    try {
      this.#storage.sql.exec(query);
    } catch (cause) {
      throw new SqlError(query, cause);
    }
  }

  ensureTables(): void {
    this.#rawSql(`
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
        deadline_at INTEGER,
        interruptions INTEGER NOT NULL DEFAULT 0,
        retry_policy TEXT,
        generation TEXT,
        next_at INTEGER,
        wait_reason TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        cancel_reason TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        updated_at INTEGER NOT NULL,
        settled_at INTEGER,
        checkpoint TEXT,
        checkpoint_turn INTEGER NOT NULL DEFAULT 0,
        definition_base TEXT,
        definition_version INTEGER NOT NULL DEFAULT 0,
        outcome TEXT,
        progress INTEGER NOT NULL DEFAULT 0,
        stream_retired INTEGER NOT NULL DEFAULT 0,
        stall INTEGER NOT NULL DEFAULT 0,
        transitions INTEGER NOT NULL DEFAULT 0,
        abort_mark TEXT,
        abort_reason TEXT,
        turn_deadline_at INTEGER,
        turn_timeout_ms INTEGER,
        paused INTEGER NOT NULL DEFAULT 0,
        parent_run_id TEXT,
        parent_owner_key TEXT,
        parent_notify INTEGER NOT NULL DEFAULT 1,
        background INTEGER NOT NULL DEFAULT 0,
        stream_epoch INTEGER NOT NULL DEFAULT 0,
        stream_tag TEXT
      ) WITHOUT ROWID`);
    // No (state, next_at) index: every claim, refresh, and settle rewrites
    // next_at, and Cloudflare bills each touched index as a row written —
    // a per-write tax on the hottest run mutations, paid to accelerate the
    // startup reconcile's one scan of a retention-bounded table. The
    // definition index stays: list-by-definition reads scale with retained
    // runs, and definition/created_at never change after insert.
    this.#rawSql(`
      CREATE INDEX IF NOT EXISTS cf_agents_task_runs_definition
      ON cf_agents_task_runs (definition, created_at)
    `);
    this.ensureMachineTables();
  }

  /**
   * Schema version 2: the per-run deadline, interruption counter, and
   * resolved interruption retry policy. A fresh object gets them from
   * `ensureTables`; an object created at version 1 adds them here. Adding an
   * existing column is the only expected failure and means the table is
   * already current.
   */
  addRunBudgetColumns(): void {
    this.#addColumns([
      "deadline_at INTEGER",
      "interruptions INTEGER NOT NULL DEFAULT 0",
      "retry_policy TEXT"
    ]);
  }

  /**
   * Schema version 3: the checkpoint and its turn, the derived definition
   * identity, the progress and transition counters, the abort mark, the
   * transition watchdog, the ownership tree, and the engine-owned stream's
   * identity. All plain `ADD COLUMN`, so the `state` CHECK constraint is
   * never touched and the runs table is never rebuilt.
   */
  addMachineColumns(): void {
    this.#addColumns([
      "checkpoint TEXT",
      "checkpoint_turn INTEGER NOT NULL DEFAULT 0",
      "definition_base TEXT",
      "definition_version INTEGER NOT NULL DEFAULT 0",
      "outcome TEXT",
      "progress INTEGER NOT NULL DEFAULT 0",
      "stream_retired INTEGER NOT NULL DEFAULT 0",
      "stall INTEGER NOT NULL DEFAULT 0",
      "transitions INTEGER NOT NULL DEFAULT 0",
      "abort_mark TEXT",
      "abort_reason TEXT",
      "turn_deadline_at INTEGER",
      "turn_timeout_ms INTEGER",
      "paused INTEGER NOT NULL DEFAULT 0",
      "parent_run_id TEXT",
      "parent_owner_key TEXT",
      "parent_notify INTEGER NOT NULL DEFAULT 1",
      "background INTEGER NOT NULL DEFAULT 0",
      "stream_epoch INTEGER NOT NULL DEFAULT 0",
      "stream_tag TEXT"
    ]);
    // Created with the column it indexes, never before it: an object at the
    // version 1 table shape has no `parent_run_id` until the ALTER above
    // runs. `parent_run_id` is written once at insert and never again, which
    // is the test the definition index also passes — and without it an abort
    // cascade is a full-table scan on every cancel.
    //
    // PARTIAL, because SQLite indexes NULL keys too: a plain index would be
    // touched — and so billed as a row written — by every top-level run's
    // insert, which is most of them, to store nothing but padding. The
    // partial form is still chosen by `listChildren`, since `col = ?`
    // implies `col IS NOT NULL`.
    this.#rawSql(`
      CREATE INDEX IF NOT EXISTS cf_agents_task_runs_parent
      ON cf_agents_task_runs (parent_run_id) WHERE parent_run_id IS NOT NULL
    `);
  }

  #addColumns(columns: readonly string[]): void {
    for (const column of columns) {
      const query = `ALTER TABLE cf_agents_task_runs ADD COLUMN ${column}`;
      try {
        this.#storage.sql.exec(query);
      } catch (cause) {
        if (/duplicate column/i.test(String(cause))) continue;
        throw new SqlError(query, cause);
      }
    }
  }

  /**
   * The four tables schema version 3 adds. Each is `WITHOUT ROWID` and each
   * reads through its own primary key, so none of them carries a secondary
   * index on a column a write touches.
   */
  ensureMachineTables(): void {
    // The journal is keyed by the committed checkpoint's turn, which is what
    // lets a long-lived actor retire journal rows at every checkpoint change
    // instead of accumulating them for the life of the run. No secondary
    // index: every read is a prefix or full match on the primary key, and a
    // WITHOUT ROWID table's primary key IS its b-tree.
    this.#rawSql(`
      CREATE TABLE IF NOT EXISTS cf_agents_task_journal (
        run_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('do', 'sleep', 'event', 'memo')),
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
        compensated_at INTEGER,
        PRIMARY KEY (run_id, turn, name)
      ) WITHOUT ROWID`);
    // Primary key (run_id, key) and no secondary index: `requestId` dedupe
    // is then an ON CONFLICT DO NOTHING — one statement, zero reads, zero
    // index writes — and FIFO ordering sorts a run's own prefix range in
    // memory, which `mailboxLimit` bounds. In memory and not `ORDER BY seq`
    // because `seq` is not part of the key, so SQL ordering would build a
    // temp b-tree on top of the range the key already gave us — the same
    // trade `listAsks` makes. `kind` carries no CHECK: it is a free string,
    // and the Mailbox generic types the payload, not the kind.
    this.#rawSql(`
      CREATE TABLE IF NOT EXISTS cf_agents_task_mailbox (
        run_id TEXT NOT NULL,
        key TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        type TEXT,
        payload TEXT,
        visible_after INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, key)
      ) WITHOUT ROWID`);
    // `ask_id` as the sole primary key is what makes answering routable from
    // an isolate holding nothing: the caller has one string, and it is the
    // whole key. The id carries the run id as a prefix for human legibility
    // ONLY — never split it to find the owner, because a caller-chosen run
    // id may itself contain the separator (see `deleteRun`). The owner is
    // the ask row's own `run_id`, or the route table for a facet.
    this.#rawSql(`
      CREATE TABLE IF NOT EXISTS cf_agents_task_asks (
        ask_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        name TEXT NOT NULL,
        question TEXT,
        answer TEXT,
        state TEXT NOT NULL CHECK (state IN (
          'open', 'answered', 'expired', 'withdrawn'
        )),
        expires_at INTEGER,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        answered_at INTEGER
      ) WITHOUT ROWID`);
    // The root-side owner index. It cannot be the wake mirror: a run parked
    // on a mailbox, an ask or a child legitimately carries a NULL next_at,
    // and the mirror job is cancelled for exactly that run — which is the
    // one whose owner a root most needs to find.
    this.#rawSql(`
      CREATE TABLE IF NOT EXISTS cf_agents_task_routes (
        run_id TEXT PRIMARY KEY,
        owner_path TEXT NOT NULL,
        owner_path_key TEXT NOT NULL,
        parent_run_id TEXT,
        parent_owner_key TEXT,
        definition TEXT,
        background INTEGER NOT NULL DEFAULT 0,
        settled_at INTEGER,
        created_at INTEGER NOT NULL
      ) WITHOUT ROWID`);
    // Both indexes are on columns written once at insert and never again —
    // the same test the definition index passes. The parent one is partial
    // for the same reason the runs table's is: a route row for a top-level
    // run carries a NULL parent, and an index entry for it would be one
    // more billed row write per accept for nothing.
    this.#rawSql(`
      CREATE INDEX IF NOT EXISTS cf_agents_task_routes_owner
      ON cf_agents_task_routes (owner_path_key)
    `);
    this.#rawSql(`
      CREATE INDEX IF NOT EXISTS cf_agents_task_routes_parent
      ON cf_agents_task_routes (parent_run_id) WHERE parent_run_id IS NOT NULL
    `);
  }

  /**
   * Derive the definition identity for rows written before version 3. One
   * UPDATE over the table, and only over rows that have none.
   */
  backfillDefinitionIdentity(): void {
    this.#rawSql(`
      UPDATE cf_agents_task_runs
      SET definition_base = CASE WHEN ${VERSIONED_DEFINITION}
            THEN substr(definition, 1,
                        length(rtrim(definition, '0123456789')) - 2)
            ELSE definition END,
          definition_version = CASE WHEN ${VERSIONED_DEFINITION}
            THEN CAST(substr(definition,
                             length(rtrim(definition, '0123456789')) + 1)
                      AS INTEGER)
            ELSE 0 END
      WHERE definition_base IS NULL`);
  }

  /**
   * Carry an already-requested cancellation onto the abort mark, which is
   * the write barrier version 3 fences every checkpoint-advancing write on.
   */
  backfillAbortMark(): void {
    this.#rawSql(`
      UPDATE cf_agents_task_runs
      SET abort_mark = 'cancel'
      WHERE cancel_requested = 1
        AND abort_mark IS NULL
        AND state NOT IN ('completed', 'failed', 'cancelled')`);
  }

  /** True when this object still holds the pre-version-3 step journal. */
  hasLegacyStepJournal(): boolean {
    const rows = this.sql<{ name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'cf_agents_task_steps'
    `;
    return rows.length > 0;
  }

  /** How many rows the legacy step journal still holds. */
  countLegacySteps(): number {
    const rows = this.sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM cf_agents_task_steps`;
    return rows[0]?.count ?? 0;
  }

  /**
   * Copy one batch of legacy step rows into the turn-scoped journal at turn
   * 0 and delete them from the old table. Returns the cursor the batch
   * reached, or null when nothing was left to copy.
   *
   * The caller runs this inside one `transactionSync` and persists the
   * returned cursor in the same transaction, so a crash mid-rebuild resumes
   * from the last committed batch rather than restarting.
   */
  rebuildJournalBatch(
    from: TaskJournalCursor,
    batchSize: number
  ): TaskJournalCursor | null {
    const keys = this.sql<{ run_id: string; step_name: string }>`
      SELECT run_id, step_name FROM cf_agents_task_steps
      WHERE (run_id, step_name) > (${from.runId}, ${from.name})
      ORDER BY run_id, step_name
      LIMIT ${batchSize}
    `;
    const last = keys.at(-1);
    if (!last) return null;
    const to: TaskJournalCursor = { runId: last.run_id, name: last.step_name };
    this.sql`
      INSERT OR REPLACE INTO cf_agents_task_journal
        (run_id, turn, name, kind, state, result, error_name, error_message,
         attempt, next_at, created_at, started_at, updated_at, completed_at)
      SELECT run_id, 0, step_name, kind, state, result, error_name,
             error_message, attempt, next_at, created_at, started_at,
             updated_at, completed_at
      FROM cf_agents_task_steps
      WHERE (run_id, step_name) > (${from.runId}, ${from.name})
        AND (run_id, step_name) <= (${to.runId}, ${to.name})
    `;
    this.sql`
      DELETE FROM cf_agents_task_steps
      WHERE (run_id, step_name) > (${from.runId}, ${from.name})
        AND (run_id, step_name) <= (${to.runId}, ${to.name})
    `;
    return to;
  }

  /** Drop the legacy step journal once every row has been copied. */
  dropLegacyStepJournal(): void {
    this.#rawSql("DROP TABLE IF EXISTS cf_agents_task_steps");
  }

  rowToSnapshot<Output extends StateMachineValue>(
    row: TaskRunRow
  ): StateMachineRunSnapshot<Output> {
    const metadata =
      row.metadata !== null
        ? (JSON.parse(row.metadata) as Record<string, StateMachineJson>)
        : undefined;
    const base = {
      runId: row.run_id,
      definition: row.definition,
      createdAt: row.created_at,
      ...(metadata !== undefined ? { metadata } : {})
    };
    // A mark that has landed but not yet settled is what a caller sees
    // between `cancel()` and the cancel transition's own write.
    const aborting =
      row.abort_mark !== null
        ? {
            abortRequested: true as const,
            ...(row.abort_reason !== null
              ? { abortReason: row.abort_reason }
              : {})
          }
        : {};
    const outcome = row.outcome !== null ? { outcome: row.outcome } : {};
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
            : {}),
          ...aborting
        };
      case "waiting":
        return {
          ...base,
          state: "waiting",
          reason: row.wait_reason ?? "sleep",
          // Omitted rather than defaulted: a run parked on the mailbox, an
          // ask or a child has no wake time at all, and reporting
          // `updated_at` would name a past instant as a future wake.
          ...(row.next_at !== null ? { wakeAt: row.next_at } : {}),
          ...(row.status_message !== null
            ? { statusMessage: row.status_message }
            : {}),
          ...aborting
        };
      case "completed":
        return {
          ...base,
          state: "completed",
          result: deserializeTaskValue(row.result) as Output,
          settledAt: row.settled_at ?? row.updated_at,
          ...outcome
        };
      case "failed":
        return {
          ...base,
          state: "failed",
          error: {
            name: row.error_name ?? "Error",
            message: row.error_message ?? "Task run failed"
          },
          settledAt: row.settled_at ?? row.updated_at,
          ...outcome
        };
      case "cancelled":
        return {
          ...base,
          state: "cancelled",
          ...(row.cancel_reason !== null ? { reason: row.cancel_reason } : {}),
          settledAt: row.settled_at ?? row.updated_at,
          ...outcome
        };
    }
  }

  /**
   * The deep read: the snapshot plus the checkpoint and everything the run
   * owns. Four bounded prefix reads and no writes.
   */
  rowToView<Output extends StateMachineValue, State>(
    row: TaskRunRow
  ): StateMachineRunView<Output, State> {
    return {
      snapshot: this.rowToSnapshot<Output>(row),
      checkpoint: deserializeTaskValue(row.checkpoint) as State,
      turn: row.checkpoint_turn,
      progress: row.progress,
      transitions: row.transitions,
      mailbox: this.listMailbox(row.run_id),
      asks: this.listAsks(row.run_id),
      children: this.listChildren(row.run_id)
    };
  }

  /**
   * Every queued mailbox item of one run, in FIFO order across kinds.
   * Ordered in memory for the reason the schema comment gives: `seq` is not
   * part of the (run_id, key) key, so an `ORDER BY` would add a temp b-tree
   * to a prefix range `mailboxLimit` already bounds.
   */
  listMailbox(runId: string): StateMachineMailboxItem[] {
    const rows = this.sql<TaskMailboxRow>`
      SELECT * FROM cf_agents_task_mailbox WHERE run_id = ${runId}
    `;
    rows.sort((left, right) => left.seq - right.seq);
    return rows.map((row) => ({
      key: row.key,
      seq: row.seq,
      kind: row.kind,
      ...(row.type !== null ? { type: row.type } : {}),
      payload: deserializeTaskValue(row.payload) as StateMachineJson,
      createdAt: row.created_at
    }));
  }

  /**
   * Every ask of one run, answered and lapsed ones included. Ordered in
   * memory: `ask_id` is the table's only key, so SQL ordering would add a
   * temp b-tree on top of the scan the `run_id` predicate already costs,
   * and the set is bounded by the run's own asks.
   */
  listAsks(runId: string): StateMachineAskRecord[] {
    return this.queryAsks({ runId });
  }

  /** Asks by run and/or state, oldest first, ties broken by id. */
  queryAsks(filter: {
    runId?: string;
    state?: StateMachineAskState;
  }): StateMachineAskRecord[] {
    const clauses: string[] = [];
    const params: (string | number | null)[] = [];
    if (filter.runId !== undefined) {
      clauses.push("run_id = ?");
      params.push(filter.runId);
    }
    if (filter.state !== undefined) {
      clauses.push("state = ?");
      params.push(filter.state);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = this.read<TaskAskRow>(
      `SELECT * FROM cf_agents_task_asks${where}`,
      params
    );
    rows.sort(
      (left, right) =>
        left.created_at - right.created_at ||
        (left.ask_id < right.ask_id ? -1 : left.ask_id > right.ask_id ? 1 : 0)
    );
    return rows.map(askRecord);
  }

  /** One ask row by id, or undefined. */
  getAsk(askId: string): TaskAskRow | undefined {
    return this.read<TaskAskRow>(
      "SELECT * FROM cf_agents_task_asks WHERE ask_id = ?",
      [askId]
    )[0];
  }

  listChildren(runId: string): StateMachineChildRef[] {
    const rows = this.sql<{
      run_id: string;
      definition: string;
      background: number;
    }>`
      SELECT run_id, definition, background
      FROM cf_agents_task_runs
      WHERE parent_run_id = ${runId}
        AND state NOT IN ('completed', 'failed', 'cancelled')
      ORDER BY created_at
    `;
    const local = rows.map((row) => ({
      runId: row.run_id,
      definition: row.definition,
      background: row.background === 1
    }));
    const routed = this.listRoutedChildren(runId, { inTree: false }).map(
      (row) => ({
        runId: row.run_id,
        definition: row.definition ?? "",
        background: row.background === 1,
        ownerKey: row.owner_path_key
      })
    );
    return [...local, ...routed];
  }

  // ── Routes ──────────────────────────────────────────────────────────────

  /** The route row of a run this Lifecycle reaches elsewhere, if any. */
  getRoute(runId: string): TaskRouteRow | undefined {
    return this.sql<TaskRouteRow>`
      SELECT * FROM cf_agents_task_routes WHERE run_id = ${runId}
    `[0];
  }

  /** Record where a run lives. A row for the same run is rewritten. */
  upsertRoute(route: {
    runId: string;
    owner: LifecycleRouteAddress;
    parentRunId: string | null;
    parentOwnerKey: string | null;
    definition: string | null;
    background: boolean;
  }): void {
    this.write(
      `INSERT INTO cf_agents_task_routes
         (run_id, owner_path, owner_path_key, parent_run_id, parent_owner_key,
          definition, background, settled_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT (run_id) DO UPDATE SET
         owner_path = excluded.owner_path,
         owner_path_key = excluded.owner_path_key,
         parent_run_id = excluded.parent_run_id,
         parent_owner_key = excluded.parent_owner_key,
         definition = excluded.definition,
         background = excluded.background`,
      [
        route.runId,
        route.owner.data,
        route.owner.key,
        route.parentRunId,
        route.parentOwnerKey,
        route.definition,
        route.background ? 1 : 0,
        Date.now()
      ]
    );
  }

  deleteRoute(runId: string): boolean {
    return (
      this.write("DELETE FROM cf_agents_task_routes WHERE run_id = ?", [
        runId
      ]) > 0
    );
  }

  /** A routed child settled: it leaves its parent's live children. */
  markRouteSettled(runId: string, at: number): void {
    this.write(
      `UPDATE cf_agents_task_routes SET settled_at = ?
       WHERE run_id = ? AND settled_at IS NULL`,
      [at, runId]
    );
  }

  /** Unsettled children of `parentId` that live on another Lifecycle. */
  listRoutedChildren(
    parentId: string,
    options: { inTree: boolean }
  ): TaskRouteRow[] {
    return this.read<TaskRouteRow>(
      `SELECT * FROM cf_agents_task_routes
       WHERE parent_run_id = ? AND settled_at IS NULL
         ${options.inTree ? "AND background = 0" : ""}
       ORDER BY created_at`,
      [parentId]
    );
  }
}

/** Project one ask row as the record `asks()` and `view()` return. */
function askRecord(row: TaskAskRow): StateMachineAskRecord {
  return {
    askId: row.ask_id,
    runId: row.run_id,
    name: row.name,
    state: row.state,
    ...(row.question !== null
      ? { question: deserializeTaskValue(row.question) as StateMachineJson }
      : {}),
    ...(row.answer !== null
      ? { answer: deserializeTaskValue(row.answer) as StateMachineJson }
      : {}),
    ...(row.metadata !== null
      ? {
          metadata: JSON.parse(row.metadata) as Record<string, StateMachineJson>
        }
      : {}),
    createdAt: row.created_at,
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
    ...(row.answered_at !== null ? { answeredAt: row.answered_at } : {})
  };
}
