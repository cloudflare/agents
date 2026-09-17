import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  seedTaskAsk,
  seedTaskJournal,
  seedTaskMailbox,
  seedTaskRun,
  type TaskHarnessObject
} from "../capabilities/tasks";
import { createTaskStepEngine, RUN_SCOPED_TURN } from "../../tasks/engine-port";
import { childMailboxKey } from "../../tasks/machine";
import { AttemptSupersededError, ReplayStep } from "../../tasks/replay";
import { JOURNAL_REBUILD_START, TaskStore } from "../../tasks/store";

/**
 * The storage seams one claimed attempt drives, tested against real Durable
 * Object SQLite rather than a fake: the billed row-write budget the schema
 * commits to, the delete cascade, the journal rebuild's cursor, and the
 * turn-scoped idempotency key the engine port produces.
 *
 * Row writes are the cost that matters — one is roughly a thousand reads —
 * and every touched index is billed, NULL entries included, so the budget
 * is asserted with `rowsWritten` rather than argued in a comment.
 */

const STEP_DEFAULTS = {
  retryLimit: 3,
  retryDelayMs: 1_000,
  backoff: "exponential" as const,
  timeoutMs: 30_000
};

/** The `sql` text SQLite stored for one of Tasks' own indexes. */
function indexDdl(storage: DurableObjectStorage, name: string): string {
  const rows = storage.sql
    .exec(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`,
      name
    )
    .toArray() as Array<{ sql: string | null }>;
  return rows[0]?.sql ?? "";
}

/** The journal names one run holds in one turn, in insertion order. */
function journalNames(
  storage: DurableObjectStorage,
  runId: string,
  turn: number
): string[] {
  return (
    storage.sql
      .exec(
        `SELECT name FROM cf_agents_task_journal
         WHERE run_id = ? AND turn = ? ORDER BY created_at, name`,
        runId,
        turn
      )
      .toArray() as Array<{ name: string }>
  ).map((row) => row.name);
}

/** The plan SQLite chose for one query, joined into one line. */
function queryPlan(storage: DurableObjectStorage, query: string): string {
  return (
    storage.sql
      .exec(`EXPLAIN QUERY PLAN ${query}`, "probe")
      .toArray() as Array<{
      detail: string;
    }>
  )
    .map((row) => row.detail)
    .join(" | ");
}

/** Build the engine port for a synthetic attempt on one run. */
function portFor(
  storage: DurableObjectStorage,
  options: { runId: string; compiled: boolean }
) {
  return createTaskStepEngine({
    store: new TaskStore(storage),
    runId: options.runId,
    generation: "g-probe",
    signal: new AbortController().signal,
    claimTimeoutMs: () => 30_000,
    claimedAtMs: Date.now(),
    claimRefreshAfterMs: 15_000,
    compiled: options.compiled,
    defaults: STEP_DEFAULTS,
    emit: () => {}
  });
}

describe("the runs table's row-write budget", () => {
  it("bills no index entry for a top-level run's NULL parent", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();

        // Both parent indexes are partial. SQLite indexes NULL keys, so a
        // plain index would be touched — and billed — by every top-level
        // run's insert, which is most of them.
        expect(indexDdl(state.storage, "cf_agents_task_runs_parent")).toContain(
          "WHERE parent_run_id IS NOT NULL"
        );
        expect(
          indexDdl(state.storage, "cf_agents_task_routes_parent")
        ).toContain("WHERE parent_run_id IS NOT NULL");

        const now = Date.now();
        const insert = (runId: string, parent: string | null): number =>
          state.storage.sql.exec(
            `INSERT INTO cf_agents_task_runs
               (run_id, definition, definition_base, definition_version, state,
                parent_run_id, created_at, updated_at)
             VALUES (?, 'pipeline', 'pipeline', 0, 'pending', ?, ?, ?)`,
            runId,
            parent,
            now,
            now
          ).rowsWritten;

        // One table row, one `idempotency_key` UNIQUE entry (touched on
        // every insert, NULL included), one `runs_definition` entry — and
        // nothing for the parent until there is one.
        expect(insert("budget-top", null)).toBe(3);
        expect(insert("budget-child", "budget-top")).toBe(4);

        const routeInsert = (runId: string, parent: string | null): number =>
          state.storage.sql.exec(
            `INSERT INTO cf_agents_task_routes
               (run_id, owner_path, owner_path_key, parent_run_id,
                parent_owner_key, created_at)
             VALUES (?, 'root', 'root', ?, NULL, ?)`,
            runId,
            parent,
            now
          ).rowsWritten;

        // One table row plus the owner index; the parent index joins only
        // when the route belongs to a child.
        expect(routeInsert("budget-top", null)).toBe(2);
        expect(routeInsert("budget-child", "budget-top")).toBe(3);

        // A claim is one row: the runs table carries no (state, next_at)
        // index precisely so this stays at one.
        expect(
          state.storage.sql.exec(
            `UPDATE cf_agents_task_runs SET state = 'running', next_at = ?
             WHERE run_id = 'budget-top'`,
            now + 30_000
          ).rowsWritten
        ).toBe(1);
      }
    );
  });

  it("still reaches a run's children through the partial parent index", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();

        // `parent_run_id = ?` implies `parent_run_id IS NOT NULL`, so the
        // partial index is still the one SQLite picks.
        expect(
          queryPlan(
            state.storage,
            `SELECT run_id FROM cf_agents_task_runs WHERE parent_run_id = ?`
          )
        ).toContain("cf_agents_task_runs_parent");

        seedTaskRun(state.storage, {
          runId: "parent",
          definition: "pipeline",
          state: "running",
          nextAt: Date.now() + 60_000
        });
        seedTaskRun(state.storage, {
          runId: "kid",
          definition: "pipeline",
          state: "pending",
          nextAt: Date.now() + 60_000,
          parentRunId: "parent"
        });

        expect(new TaskStore(state.storage).listChildren("parent")).toEqual([
          { runId: "kid", definition: "pipeline", background: false }
        ]);
      }
    );
  });
});

describe("the deep read", () => {
  it("orders a run's asks by creation, breaking ties on the ask id", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        const store = new TaskStore(state.storage);

        // Seeded out of order, and two sharing a `created_at`, so both the
        // ordering key and its tie-break are exercised. `ask_id` is the
        // table's only key, so neither comes from the storage order.
        seedTaskAsk(state.storage, {
          askId: "run#c",
          runId: "asked",
          name: "approve",
          question: { toolCallId: "t3" }
        });
        seedTaskAsk(state.storage, {
          askId: "run#b",
          runId: "asked",
          name: "approve",
          state: "answered"
        });
        seedTaskAsk(state.storage, {
          askId: "run#a",
          runId: "asked",
          name: "review"
        });
        // Another run's ask, which the `run_id` predicate must exclude.
        seedTaskAsk(state.storage, {
          askId: "other#a",
          runId: "elsewhere",
          name: "approve"
        });
        // The oldest ask sorts LAST by id, so `created_at` is observably
        // what orders the list rather than the ask_id b-tree the scan walks.
        const now = Date.now();
        state.storage.sql.exec(
          `UPDATE cf_agents_task_asks SET created_at = ? WHERE ask_id = ?`,
          now - 1_000,
          "run#c"
        );
        state.storage.sql.exec(
          `UPDATE cf_agents_task_asks SET created_at = ? WHERE ask_id IN
             ('run#a', 'run#b')`,
          now
        );

        expect(store.listAsks("asked")).toEqual([
          {
            askId: "run#c",
            runId: "asked",
            name: "approve",
            state: "open",
            question: { toolCallId: "t3" },
            createdAt: now - 1_000
          },
          // Tied on `created_at`, so the ask id decides — a stable order for
          // a UI, whatever the scan happens to hand back.
          {
            askId: "run#a",
            runId: "asked",
            name: "review",
            state: "open",
            createdAt: now
          },
          {
            askId: "run#b",
            runId: "asked",
            name: "approve",
            state: "answered",
            createdAt: now
          }
        ]);
      }
    );
  });

  it("projects the checkpoint and everything the run owns in one view", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        const store = new TaskStore(state.storage);
        const future = Date.now() + 60_000;

        seedTaskRun(state.storage, {
          runId: "viewed",
          definition: "chat@v1",
          state: "running",
          generation: "g-live",
          attempt: 2,
          nextAt: future
        });
        seedTaskRun(state.storage, {
          runId: "viewed-kid",
          definition: "pipeline",
          state: "pending",
          nextAt: future,
          parentRunId: "viewed"
        });
        state.storage.sql.exec(
          `UPDATE cf_agents_task_runs
           SET checkpoint = ?, checkpoint_turn = 4, progress = 3,
               transitions = 7
           WHERE run_id = 'viewed'`,
          JSON.stringify({ phase: "awaiting", turnSeq: 2 })
        );
        // Keyed so the (run_id, key) b-tree the scan walks hands these back
        // in the WRONG order: FIFO is `seq`, which is not part of that key.
        seedTaskMailbox(state.storage, {
          runId: "viewed",
          key: "steer:a",
          kind: "user",
          seq: 1,
          payload: { text: "second" }
        });
        seedTaskMailbox(state.storage, {
          runId: "viewed",
          key: "steer:b",
          kind: "user",
          seq: 0,
          payload: { text: "first" }
        });
        seedTaskAsk(state.storage, {
          askId: "viewed#1",
          runId: "viewed",
          name: "approve"
        });

        const row = store.getRun("viewed");
        if (row === undefined) throw new Error("seeded run is missing");
        const view = store.rowToView(row);
        expect(view.snapshot).toMatchObject({
          runId: "viewed",
          state: "running",
          attempt: 2
        });
        expect(view.checkpoint).toEqual({ phase: "awaiting", turnSeq: 2 });
        expect(view.turn).toBe(4);
        expect(view.progress).toBe(3);
        expect(view.transitions).toBe(7);
        expect(view.mailbox.map((item) => item.key)).toEqual([
          "steer:b",
          "steer:a"
        ]);
        expect(view.asks.map((ask) => ask.askId)).toEqual(["viewed#1"]);
        expect(view.children).toEqual([
          { runId: "viewed-kid", definition: "pipeline", background: false }
        ]);
      }
    );
  });
});

describe("the delete cascade", () => {
  it("removes every row a run owns, including its note in its parent's mailbox", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        const store = new TaskStore(state.storage);
        const future = Date.now() + 60_000;

        seedTaskRun(state.storage, {
          runId: "parent",
          definition: "pipeline",
          state: "running",
          nextAt: future
        });
        seedTaskRun(state.storage, {
          runId: "child",
          definition: "pipeline",
          state: "running",
          nextAt: future,
          parentRunId: "parent"
        });
        seedTaskJournal(state.storage, {
          runId: "child",
          turn: 0,
          name: "work",
          kind: "do",
          state: "completed",
          result: "ok"
        });
        seedTaskMailbox(state.storage, {
          runId: "child",
          key: "steer:1",
          kind: "user"
        });
        seedTaskAsk(state.storage, {
          askId: "child#1",
          runId: "child",
          name: "approve"
        });
        state.storage.sql.exec(
          `INSERT INTO cf_agents_task_routes
             (run_id, owner_path, owner_path_key, parent_run_id,
              parent_owner_key, created_at)
           VALUES ('child', 'root', 'root', 'parent', NULL, ?)`,
          Date.now()
        );
        // The settlement note the child left in its parent's mailbox, under
        // the one key convention the writer and the cascade share.
        seedTaskMailbox(state.storage, {
          runId: "parent",
          key: childMailboxKey("child"),
          kind: "child",
          type: "pipeline"
        });
        // The parent's own unrelated item, which must survive.
        seedTaskMailbox(state.storage, {
          runId: "parent",
          key: "steer:2",
          kind: "user",
          seq: 1
        });

        store.deleteRun("child");

        const count = (table: string, column: string, value: string): number =>
          (
            state.storage.sql
              .exec(
                `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`,
                value
              )
              .toArray() as Array<{ count: number }>
          )[0]?.count ?? 0;
        expect(count("cf_agents_task_runs", "run_id", "child")).toBe(0);
        expect(count("cf_agents_task_journal", "run_id", "child")).toBe(0);
        expect(count("cf_agents_task_mailbox", "run_id", "child")).toBe(0);
        expect(count("cf_agents_task_asks", "run_id", "child")).toBe(0);
        expect(count("cf_agents_task_routes", "run_id", "child")).toBe(0);
        // Zero orphans in the parent's mailbox, and only the child's note
        // was taken.
        expect(store.listMailbox("parent").map((item) => item.key)).toEqual([
          "steer:2"
        ]);
      }
    );
  });
});

describe("the journal rebuild", () => {
  it("moves one row per batch and hands back the cursor it reached", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        const store = new TaskStore(state.storage);
        // The pre-version-3 table, recreated after the migration dropped it:
        // this exercises the copy seam directly, without a second start.
        state.storage.sql.exec(`
          CREATE TABLE cf_agents_task_steps (
            run_id TEXT NOT NULL,
            step_name TEXT NOT NULL,
            kind TEXT NOT NULL,
            state TEXT NOT NULL,
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
        const now = Date.now();
        for (const [runId, name] of [
          ["run-a", "one"],
          ["run-a", "two"],
          ["run-b", "one"]
        ] as const) {
          state.storage.sql.exec(
            `INSERT INTO cf_agents_task_steps
               (run_id, step_name, kind, state, attempt, created_at,
                updated_at)
             VALUES (?, ?, 'do', 'completed', 1, ?, ?)`,
            runId,
            name,
            now,
            now
          );
        }

        const copied = (): Array<{ run_id: string; name: string }> =>
          state.storage.sql
            .exec(
              `SELECT run_id, name FROM cf_agents_task_journal
               WHERE turn = 0 ORDER BY run_id, name`
            )
            .toArray() as Array<{ run_id: string; name: string }>;
        const remaining = (): number =>
          (
            state.storage.sql
              .exec(`SELECT COUNT(*) AS count FROM cf_agents_task_steps`)
              .toArray() as Array<{ count: number }>
          )[0]?.count ?? 0;

        // One batch, one row: the copy, the delete, and the cursor it
        // reached all move together.
        const first = store.rebuildJournalBatch(JOURNAL_REBUILD_START, 1);
        expect(first).toEqual({ runId: "run-a", name: "one" });
        expect(copied()).toEqual([{ run_id: "run-a", name: "one" }]);
        expect(remaining()).toBe(2);
        if (first === null) throw new Error("unreachable");

        const second = store.rebuildJournalBatch(first, 1);
        expect(second).toEqual({ runId: "run-a", name: "two" });
        expect(copied()).toHaveLength(2);
        expect(remaining()).toBe(1);
        if (second === null) throw new Error("unreachable");

        const third = store.rebuildJournalBatch(second, 1);
        expect(third).toEqual({ runId: "run-b", name: "one" });
        expect(remaining()).toBe(0);
        if (third === null) throw new Error("unreachable");

        // Nothing left above the cursor: the loop's exit condition.
        expect(store.rebuildJournalBatch(third, 1)).toBeNull();
        expect(copied()).toEqual([
          { run_id: "run-a", name: "one" },
          { run_id: "run-a", name: "two" },
          { run_id: "run-b", name: "one" }
        ]);
      }
    );
  });

  it("skips everything at or below the cursor it resumes from", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        const store = new TaskStore(state.storage);
        state.storage.sql.exec(`
          CREATE TABLE cf_agents_task_steps (
            run_id TEXT NOT NULL,
            step_name TEXT NOT NULL,
            kind TEXT NOT NULL,
            state TEXT NOT NULL,
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
        const now = Date.now();
        for (const name of ["aaa", "zzz"]) {
          state.storage.sql.exec(
            `INSERT INTO cf_agents_task_steps
               (run_id, step_name, kind, state, attempt, created_at,
                updated_at)
             VALUES ('run-a', ?, 'do', 'completed', 1, ?, ?)`,
            name,
            now,
            now
          );
        }

        // A crash left the cursor past "aaa" — already copied and deleted in
        // the real sequence, left behind here so an ignored cursor is
        // observable rather than merely idempotent.
        const moved = store.rebuildJournalBatch(
          { runId: "run-a", name: "aaa" },
          100
        );

        expect(moved).toEqual({ runId: "run-a", name: "zzz" });
        expect(
          state.storage.sql
            .exec(
              `SELECT name FROM cf_agents_task_journal WHERE turn = 0
               ORDER BY name`
            )
            .toArray()
        ).toEqual([{ name: "zzz" }]);
        // "aaa" was neither copied nor deleted: it sits below the cursor.
        expect(
          state.storage.sql
            .exec(`SELECT step_name FROM cf_agents_task_steps`)
            .toArray()
        ).toEqual([{ step_name: "aaa" }]);
      }
    );
  });
});

describe("the ask port's owner scoping", () => {
  it("reads, settles and withdraws only the asks of its own run", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        // Two runs, and an ask id whose run-id prefix names the WRONG run:
        // the id carries the owner for legibility only, so routing that
        // trusted the prefix would reach across runs. A caller-chosen run
        // id may itself contain the separator, which is why the row's own
        // `run_id` is the only owner the port reads.
        seedTaskAsk(state.storage, {
          askId: "mine#1",
          runId: "mine",
          name: "approve"
        });
        seedTaskAsk(state.storage, {
          askId: "mine#2",
          runId: "theirs",
          name: "approve"
        });
        const engine = portFor(state.storage, {
          runId: "mine",
          compiled: false
        });

        expect(
          engine.readAsks(["mine#1", "mine#2"]).map((ask) => ask.ask_id)
        ).toEqual(["mine#1"]);
        // The two writing siblings already scope themselves; this pins that
        // the reader now agrees with them.
        expect(engine.settleAsk("mine#2", "answered", "1")).toBe(false);
        expect(engine.withdrawOpenAsks()).toBe(1);
        expect(
          (
            state.storage.sql
              .exec(
                "SELECT state FROM cf_agents_task_asks WHERE ask_id = ?",
                "mine#2"
              )
              .toArray() as Array<{ state: string }>
          ).at(0)?.state
        ).toBe("open");
      }
    );
  });
});

describe("turn-scoped idempotency keys", () => {
  it("omits the turn for a compiled function definition, whatever the turn", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        const engine = portFor(state.storage, {
          runId: "run_1",
          compiled: true
        });

        expect(engine.stepIdempotencyKey(0, "charge")).toBe("run_1:charge");
        expect(engine.stepIdempotencyKey(7, "charge")).toBe("run_1:charge");
      }
    );
  });

  it("scopes a machine's key to the turn the step ran in", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        const engine = portFor(state.storage, {
          runId: "run_1",
          compiled: false
        });

        expect(engine.stepIdempotencyKey(7, "charge")).toBe("run_1:t7:charge");
        // A machine that wants one key across turns asks for it.
        expect(engine.stepIdempotencyKey(7, "charge", "run")).toBe(
          "run_1:charge"
        );

        // The replay surface carries its own turn to the port rather than
        // assuming 0: without that, every turn's key would collide.
        const step = new ReplayStep(engine, {
          attempt: 1,
          startsLive: true,
          turn: 7
        });
        expect(step.idempotencyKey("charge")).toBe("run_1:t7:charge");
        expect(step.idempotencyKey("charge", { scope: "run" })).toBe(
          "run_1:charge"
        );
      }
    );
  });
});

describe("the port statements the machine engine will drive", () => {
  it("round-trips memos, the mailbox, asks, children and the checkpoint", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        // These statements have no caller until the dispatch loop lands, so
        // without this the engine's first run would be the first thing to
        // execute them. Every one is exercised against real SQLite here.
        seedTaskRun(state.storage, {
          runId: "run_1",
          definition: "counter",
          state: "running",
          generation: "g-probe",
          nextAt: Date.now() + 60_000
        });
        seedTaskRun(state.storage, {
          runId: "child_1",
          definition: "counter",
          state: "running",
          nextAt: Date.now() + 60_000,
          parentRunId: "run_1"
        });
        const engine = portFor(state.storage, {
          runId: "run_1",
          compiled: false
        });

        // Memos live in the run scope, outside every turn.
        expect(engine.readMemo("seed")).toBeUndefined();
        expect(engine.writeMemo("seed", '"abc"')).toBe(true);
        expect(engine.readMemo("seed")?.result).toBe('"abc"');
        // Second write of the same memo loses: a memo is decided once.
        expect(engine.writeMemo("seed", '"xyz"')).toBe(false);
        expect(engine.readMemo("seed")?.result).toBe('"abc"');

        // Mailbox: FIFO by seq, deduped by key, filtered by kind, and
        // invisible until its delay elapses.
        const now = Date.now();
        expect(engine.nextMailboxSeq()).toBe(0);
        expect(
          engine.appendMailbox({
            key: "m1",
            seq: 0,
            kind: "message",
            type: null,
            payload: '{"text":"hi"}',
            visibleAfter: null
          })
        ).toBe(true);
        // The same key again is the dedupe the send receipt reports.
        expect(
          engine.appendMailbox({
            key: "m1",
            seq: 1,
            kind: "message",
            type: null,
            payload: null,
            visibleAfter: null
          })
        ).toBe(false);
        expect(
          engine.appendMailbox({
            key: "later",
            seq: 1,
            kind: "message",
            type: null,
            payload: null,
            visibleAfter: now + 60_000
          })
        ).toBe(true);
        expect(engine.nextMailboxSeq()).toBe(2);
        expect(engine.countMailbox()).toBe(2);
        expect(
          engine.peekMailbox(undefined, now).map((row) => row.key)
        ).toEqual(["m1"]);
        expect(engine.peekMailbox({ kind: "child" }, now)).toEqual([]);
        expect(engine.consumeMailbox(["m1", "absent"])).toBe(1);
        expect(engine.consumeMailbox(["m1"])).toBe(0);

        // Asks are written by the port and read back by the sibling it
        // already scopes.
        engine.insertAsk({
          askId: "run_1#1",
          turn: 0,
          name: "approve",
          question: '{"toolCallId":"t1"}',
          expiresAt: null,
          metadata: null
        });
        expect(engine.readAsks(["run_1#1"]).map((ask) => ask.name)).toEqual([
          "approve"
        ]);

        expect(engine.listChildren().map((child) => child.runId)).toEqual([
          "child_1"
        ]);

        // Progress credit is in-memory bookkeeping, not a row write.
        expect(engine.progressCredited()).toBe(0);
        engine.creditProgress(2);
        expect(engine.progressCredited()).toBe(2);

        // The fenced commit, with a turn to retire.
        seedTaskJournal(state.storage, {
          runId: "run_1",
          turn: 0,
          name: "old",
          kind: "do",
          state: "completed"
        });
        expect(
          engine.commitCheckpoint({
            checkpoint: '{"phase":"counting","value":1}',
            turn: 1,
            retireTurn: 0,
            transitions: 1,
            stall: 0,
            progress: 2
          })
        ).toBe(true);
        const committed = (
          state.storage.sql
            .exec(
              `SELECT checkpoint, checkpoint_turn, transitions, progress
               FROM cf_agents_task_runs WHERE run_id = ?`,
              "run_1"
            )
            .toArray() as Array<{
            checkpoint: string | null;
            checkpoint_turn: number;
            transitions: number;
            progress: number;
          }>
        ).at(0);
        expect(committed).toMatchObject({
          checkpoint: '{"phase":"counting","value":1}',
          checkpoint_turn: 1,
          transitions: 1,
          progress: 2
        });
        expect(journalNames(state.storage, "run_1", 0)).toEqual([]);
        // The memo survived the retire: it belongs to the run scope, which
        // turn retirement never touches.
        expect(engine.readMemo("seed")?.result).toBe('"abc"');
      }
    );
  });

  it("fences the retire and the commit on the attempt's generation", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        seedTaskRun(state.storage, {
          runId: "run_1",
          definition: "counter",
          state: "running",
          generation: "g-live",
          nextAt: Date.now() + 60_000
        });
        seedTaskJournal(state.storage, {
          runId: "run_1",
          turn: 0,
          name: "kept",
          kind: "do",
          state: "completed"
        });
        // A superseded attempt: same run, a generation the row no longer
        // carries. It must neither commit nor delete the journal its
        // successor is replaying against.
        const stale = portFor(state.storage, {
          runId: "run_1",
          compiled: false
        });

        expect(
          stale.commitCheckpoint({
            checkpoint: '{"phase":"counting","value":9}',
            turn: 1,
            retireTurn: 0,
            transitions: 1,
            stall: 0,
            progress: 0
          })
        ).toBe(false);
        expect(() => stale.retireJournal(0)).toThrow(AttemptSupersededError);
        expect(journalNames(state.storage, "run_1", 0)).toEqual(["kept"]);
      }
    );
  });

  it("refuses to commit once the abort mark has landed", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        seedTaskRun(state.storage, {
          runId: "run_1",
          definition: "counter",
          state: "running",
          generation: "g-probe",
          nextAt: Date.now() + 60_000
        });
        state.storage.sql.exec(
          `UPDATE cf_agents_task_runs SET abort_mark = 'cancel'
           WHERE run_id = ?`,
          "run_1"
        );
        const engine = portFor(state.storage, {
          runId: "run_1",
          compiled: false
        });

        // The mark is the write barrier: a transition in flight when a
        // cancel lands cannot advance the checkpoint past it.
        expect(
          engine.commitCheckpoint({
            checkpoint: '{"phase":"counting","value":1}',
            turn: 1,
            retireTurn: null,
            transitions: 1,
            stall: 0,
            progress: 0
          })
        ).toBe(false);
      }
    );
  });

  it("never retires the run scope, whichever path asks for it", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        seedTaskRun(state.storage, {
          runId: "run_1",
          definition: "counter",
          state: "running",
          generation: "g-probe",
          nextAt: Date.now() + 60_000
        });
        const engine = portFor(state.storage, {
          runId: "run_1",
          compiled: false
        });
        engine.writeMemo("seed", '"abc"');

        // `RUN_SCOPED_TURN` is an ordinary number, so both retire paths
        // have to exclude it rather than trust no caller passes it.
        engine.retireJournal(RUN_SCOPED_TURN);
        expect(engine.readMemo("seed")?.result).toBe('"abc"');
        expect(
          engine.commitCheckpoint({
            checkpoint: null,
            turn: 1,
            retireTurn: RUN_SCOPED_TURN,
            transitions: 1,
            stall: 0,
            progress: 0
          })
        ).toBe(true);
        expect(engine.readMemo("seed")?.result).toBe('"abc"');
      }
    );
  });
});
