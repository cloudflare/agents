import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { TaskHarnessObject } from "../capabilities/tasks";
import type { TaskRunSnapshot, TaskValue } from "../../tasks";

/**
 * Storage migration onto schema version 3: the machine columns, the four
 * new tables, and the rebuild of `cf_agents_task_steps` into the
 * turn-scoped `cf_agents_task_journal`.
 *
 * Every case drives the real capability on a real Durable Object, starting
 * from a hand-written pre-version-3 schema — the only way to prove an
 * upgrade keeps in-flight runs resumable, since a fresh object never sees
 * the old shape.
 */

const VERSION_KEY = "cf_agents:tasks_schema_version";
const CURSOR_KEY = "cf_agents:tasks_journal_cursor";

/** The runs table as version 1 created it, before the budget columns. */
function createV1RunsTable(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE cf_agents_task_runs (
      run_id TEXT PRIMARY KEY,
      definition TEXT NOT NULL,
      input TEXT,
      state TEXT NOT NULL,
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
}

/** The runs table as version 2 left it: version 1 plus the budget columns. */
function createV2RunsTable(storage: DurableObjectStorage): void {
  createV1RunsTable(storage);
  for (const column of [
    "deadline_at INTEGER",
    "interruptions INTEGER NOT NULL DEFAULT 0",
    "retry_policy TEXT"
  ]) {
    storage.sql.exec(`ALTER TABLE cf_agents_task_runs ADD COLUMN ${column}`);
  }
}

/** The step journal versions 1 and 2 wrote, keyed `(run_id, step_name)`. */
function createLegacyStepTable(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE cf_agents_task_steps (
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
    ) WITHOUT ROWID`);
}

function seedLegacyRun(
  storage: DurableObjectStorage,
  options: {
    readonly runId: string;
    readonly definition: string;
    readonly input?: unknown;
    readonly state: "pending" | "running" | "waiting";
    readonly waitReason?: string;
    readonly nextAt: number;
    readonly cancelRequested?: boolean;
  }
): void {
  const now = Date.now();
  storage.sql.exec(
    `INSERT INTO cf_agents_task_runs
       (run_id, definition, input, state, wait_reason, next_at,
        cancel_requested, retain, attempt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    options.runId,
    options.definition,
    options.input === undefined ? null : JSON.stringify(options.input),
    options.state,
    options.waitReason ?? null,
    options.nextAt,
    options.cancelRequested === true ? 1 : 0,
    now,
    now
  );
  storage.sql.exec(
    `CREATE TABLE IF NOT EXISTS cf_agents_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      capability TEXT NOT NULL,
      fn TEXT NOT NULL,
      time INTEGER NOT NULL,
      payload TEXT,
      retry_options TEXT,
      singleflight INTEGER NOT NULL DEFAULT 0,
      hung_timeout_seconds INTEGER,
      exclusive INTEGER NOT NULL DEFAULT 0,
      recovery_loop INTEGER NOT NULL DEFAULT 0,
      running INTEGER NOT NULL DEFAULT 0,
      execution_started_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`
  );
  storage.sql.exec(
    `INSERT OR REPLACE INTO cf_agents_jobs (id, capability, fn, time)
     VALUES (?, 'tasks', 'wake', ?)`,
    `task:${options.runId}`,
    options.nextAt
  );
}

function seedLegacyStep(
  storage: DurableObjectStorage,
  options: {
    readonly runId: string;
    readonly name: string;
    readonly kind: "do" | "sleep";
    readonly state: "running" | "waiting" | "completed";
    readonly result?: unknown;
    readonly nextAt?: number;
  }
): void {
  const now = Date.now();
  storage.sql.exec(
    `INSERT INTO cf_agents_task_steps
       (run_id, step_name, kind, state, result, attempt, next_at,
        created_at, started_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    options.runId,
    options.name,
    options.kind,
    options.state,
    options.result === undefined ? null : JSON.stringify(options.result),
    options.state === "completed" ? 1 : 0,
    options.nextAt ?? null,
    now,
    now,
    now,
    options.state === "completed" ? now : null
  );
}

function tableNames(storage: DurableObjectStorage): string[] {
  return (
    storage.sql
      .exec(
        `SELECT name FROM sqlite_master WHERE type = 'table'
           AND name LIKE 'cf_agents_task%' ORDER BY name`
      )
      .toArray() as Array<{ name: string }>
  ).map((row) => row.name);
}

function columnNames(storage: DurableObjectStorage): string[] {
  return (
    storage.sql
      .exec("PRAGMA table_info(cf_agents_task_runs)")
      .toArray() as Array<{ name: string }>
  ).map((column) => column.name);
}

function journalRows(
  storage: DurableObjectStorage
): Array<{ run_id: string; turn: number; name: string; state: string }> {
  return storage.sql
    .exec(
      `SELECT run_id, turn, name, state FROM cf_agents_task_journal
       ORDER BY run_id, turn, name`
    )
    .toArray() as Array<{
    run_id: string;
    turn: number;
    name: string;
    state: string;
  }>;
}

/**
 * Record every schema version this object durably stamps, in order. Each
 * stamp is one billed durable write, and the intermediate version earns one
 * only when there is a rebuild to make resumable.
 */
function watchSchemaStamps(storage: DurableObjectStorage): number[] {
  const stamped: number[] = [];
  const put = storage.put.bind(storage);
  // SAFETY: an observer, not a substitute — it records the one key under
  // test and delegates every call, of either overload, unchanged.
  (storage as { put: unknown }).put = (
    key: unknown,
    value: unknown,
    ...rest: unknown[]
  ) => {
    if (key === VERSION_KEY && typeof value === "number") stamped.push(value);
    return (put as (...args: unknown[]) => unknown)(key, value, ...rest);
  };
  return stamped;
}

/**
 * Record every write to the rebuild cursor. The rebuild persists it through
 * the synchronous KV surface inside each batch's transaction rather than
 * through `storage.put`, so this observer wraps that object instead of the
 * one `watchSchemaStamps` wraps.
 */
function watchCursorWrites(storage: DurableObjectStorage): {
  readonly puts: string[];
  readonly deletes: number;
} {
  const puts: string[] = [];
  const record = { puts, deletes: 0 };
  const kv = storage.kv;
  const put = kv.put.bind(kv);
  const remove = kv.delete.bind(kv);
  // SAFETY: an observer, not a substitute — it records the one key under
  // test and delegates every call, of either overload, unchanged.
  (kv as { put: unknown }).put = (key: unknown, ...rest: unknown[]) => {
    const [value] = rest;
    if (key === CURSOR_KEY && typeof value === "string") puts.push(value);
    return (put as (...args: unknown[]) => unknown)(key, ...rest);
  };
  (kv as { delete: unknown }).delete = (key: unknown, ...rest: unknown[]) => {
    if (key === CURSOR_KEY) record.deletes += 1;
    return (remove as (...args: unknown[]) => unknown)(key, ...rest);
  };
  return record;
}

/** Poll one run until it reaches one of the given states. */
async function waitForState(
  tasks: { get(runId: string): Promise<TaskRunSnapshot<TaskValue> | null> },
  runId: string,
  states: ReadonlyArray<TaskRunSnapshot<TaskValue>["state"]>,
  timeoutMs = 5_000
): Promise<TaskRunSnapshot<TaskValue>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await tasks.get(runId);
    if (snapshot && states.includes(snapshot.state)) return snapshot;
    if (Date.now() > deadline) {
      throw new Error(
        `Run ${runId} stuck in state "${snapshot?.state}" after ${timeoutMs}ms`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Tasks schema version 3 migration", () => {
  it("creates the version 3 schema on a fresh object and records nothing to rebuild", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const schemaStamps = watchSchemaStamps(state.storage);
        await instance.lifecycle.start();

        expect(tableNames(state.storage)).toEqual([
          "cf_agents_task_asks",
          "cf_agents_task_journal",
          "cf_agents_task_mailbox",
          "cf_agents_task_routes",
          "cf_agents_task_runs"
        ]);
        expect(await state.storage.get(VERSION_KEY)).toBe(3);
        // A fresh object never pays for the rebuild: no cursor is written.
        expect(await state.storage.get(CURSOR_KEY)).toBeUndefined();
        // Nor does it pay for the intermediate version. That stamp exists to
        // make a rebuild resumable, so an object with nothing to rebuild
        // goes straight to 3 and bills ONE durable write rather than two.
        expect(schemaStamps).toEqual([3]);

        const receipt = await instance.tasks.run("checkpointing");
        const snapshot = await waitForState(instance.tasks, receipt.runId, [
          "completed"
        ]);
        expect(snapshot.state).toBe("completed");
      }
    );
  });

  it("drops an empty legacy step journal without paying for a rebuild", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        // An upgraded object whose retained runs were all swept — by the
        // very `tasks.delete({ settledBefore })` the rebuild's warning asks
        // for before an upgrade — carries the old table with nothing in it.
        // Deciding on the ROW COUNT would stamp 3 and leave the table
        // behind, so the object would report itself fully migrated while a
        // stale host query kept reading an empty table forever.
        createV2RunsTable(state.storage);
        createLegacyStepTable(state.storage);
        await state.storage.put(VERSION_KEY, 2);

        const schemaStamps = watchSchemaStamps(state.storage);
        const cursor = watchCursorWrites(state.storage);
        await instance.lifecycle.start();

        expect(await state.storage.get(VERSION_KEY)).toBe(3);
        expect(tableNames(state.storage)).not.toContain("cf_agents_task_steps");
        // Nothing to copy, so nothing to resume: one stamp, no cursor.
        expect(schemaStamps).toEqual([3]);
        expect(cursor.puts).toEqual([]);
      }
    );
  });

  it("upgrades a version 0 object whose table is already at the version 1 shape", async () => {
    // The case the unconditional `addRunBudgetColumns()` exists for: the
    // table carries the version 1 shape while the version key is absent, so
    // a guard narrower than `version < 2` would record the object migrated
    // without ever adding the columns every later acceptance names.
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    const runId = "v0-run";
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        createV1RunsTable(state.storage);
        createLegacyStepTable(state.storage);
        seedLegacyRun(state.storage, {
          runId,
          definition: "sleeper",
          input: { ms: 1 },
          state: "waiting",
          waitReason: "sleep",
          nextAt: Date.now() - 1_000
        });
        seedLegacyStep(state.storage, {
          runId,
          name: "before",
          kind: "do",
          state: "completed",
          result: "before"
        });
        seedLegacyStep(state.storage, {
          runId,
          name: "nap",
          kind: "sleep",
          state: "waiting",
          nextAt: Date.now() - 1_000
        });
        // No VERSION_KEY at all — the actual version 0 shape.
        expect(await state.storage.get(VERSION_KEY)).toBeUndefined();

        await instance.lifecycle.start();

        expect(columnNames(state.storage)).toEqual(
          expect.arrayContaining([
            "deadline_at",
            "interruptions",
            "retry_policy",
            "checkpoint",
            "checkpoint_turn",
            "abort_mark",
            "parent_run_id",
            "transitions"
          ])
        );
        expect(await state.storage.get(VERSION_KEY)).toBe(3);
        expect(tableNames(state.storage)).not.toContain("cf_agents_task_steps");
        expect(journalRows(state.storage)).toEqual([
          { run_id: runId, turn: 0, name: "before", state: "completed" },
          { run_id: runId, turn: 0, name: "nap", state: "waiting" }
        ]);

        const snapshot = await waitForState(instance.tasks, runId, [
          "completed"
        ]);
        expect(snapshot.state).toBe("completed");
        expect(instance.stepRuns).toEqual(["sleeper:after"]);
      }
    );
  });

  it("upgrades a version 1 object to version 3, adding both column sets", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        createV1RunsTable(state.storage);
        createLegacyStepTable(state.storage);
        seedLegacyRun(state.storage, {
          runId: "v1-run",
          definition: "checkpointing",
          state: "waiting",
          waitReason: "retry",
          nextAt: Date.now() + 60_000
        });
        seedLegacyStep(state.storage, {
          runId: "v1-run",
          name: "mark",
          kind: "do",
          state: "completed",
          result: "ok"
        });
        await state.storage.put(VERSION_KEY, 1);

        await instance.lifecycle.start();

        const columns = columnNames(state.storage);
        expect(columns).toEqual(
          expect.arrayContaining([
            "deadline_at",
            "interruptions",
            "retry_policy",
            "checkpoint",
            "checkpoint_turn",
            "definition_base",
            "definition_version",
            "outcome",
            "progress",
            "stall",
            "transitions",
            "abort_mark",
            "abort_reason",
            "turn_deadline_at",
            "turn_timeout_ms",
            "paused",
            "parent_run_id",
            "background",
            "stream_epoch",
            "stream_tag"
          ])
        );
        expect(await state.storage.get(VERSION_KEY)).toBe(3);
        expect(tableNames(state.storage)).not.toContain("cf_agents_task_steps");
        expect(journalRows(state.storage)).toEqual([
          { run_id: "v1-run", turn: 0, name: "mark", state: "completed" }
        ]);
      }
    );
  });

  it("resumes a version 2 run parked on a sleep without re-executing its completed step", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    const runId = "v2-sleeper";
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        createV2RunsTable(state.storage);
        createLegacyStepTable(state.storage);
        const past = Date.now() - 1_000;
        seedLegacyRun(state.storage, {
          runId,
          definition: "sleeper",
          input: { ms: 1 },
          state: "waiting",
          waitReason: "sleep",
          nextAt: past
        });
        seedLegacyStep(state.storage, {
          runId,
          name: "before",
          kind: "do",
          state: "completed",
          result: "before"
        });
        seedLegacyStep(state.storage, {
          runId,
          name: "nap",
          kind: "sleep",
          state: "waiting",
          nextAt: past
        });
        await state.storage.put(VERSION_KEY, 2);

        await instance.lifecycle.start();

        // The rebuild carried both rows forward at turn 0 — the journal
        // scope a function definition never leaves.
        expect(journalRows(state.storage)).toEqual([
          { run_id: runId, turn: 0, name: "before", state: "completed" },
          { run_id: runId, turn: 0, name: "nap", state: "waiting" }
        ]);
        expect(tableNames(state.storage)).not.toContain("cf_agents_task_steps");

        const snapshot = await waitForState(instance.tasks, runId, [
          "completed"
        ]);
        expect(snapshot.state).toBe("completed");
        // The completed step replayed from the journal; only the step past
        // the sleep actually ran.
        expect(instance.stepRuns).toEqual(["sleeper:after"]);
      }
    );
  });

  it("keeps a migrated run's step idempotency key byte-identical", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    const runId = "v2-keyed";
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        createV2RunsTable(state.storage);
        createLegacyStepTable(state.storage);
        seedLegacyRun(state.storage, {
          runId,
          definition: "keyed",
          state: "pending",
          nextAt: Date.now() - 1_000
        });
        await state.storage.put(VERSION_KEY, 2);

        await instance.lifecycle.start();
        await waitForState(instance.tasks, runId, ["completed"]);

        // No turn segment: a function definition is a single-checkpoint
        // machine whose turn is always 0, and its key form is the one Tasks
        // has always written.
        expect(instance.stepKeys).toEqual([`${runId}:keyed-step`]);
      }
    );
  });

  it("carries a requested cancellation onto the abort mark", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        createV2RunsTable(state.storage);
        createLegacyStepTable(state.storage);
        seedLegacyRun(state.storage, {
          runId: "cancelled-live",
          definition: "checkpointing",
          state: "waiting",
          waitReason: "sleep",
          nextAt: Date.now() + 60_000,
          cancelRequested: true
        });
        // A terminal row is left alone: its cancellation already resolved.
        seedLegacyRun(state.storage, {
          runId: "cancelled-clean",
          definition: "checkpointing",
          state: "pending",
          nextAt: Date.now() + 60_000
        });
        await state.storage.put(VERSION_KEY, 2);

        await instance.lifecycle.start();

        const marks = state.storage.sql
          .exec(
            `SELECT run_id, abort_mark FROM cf_agents_task_runs
             ORDER BY run_id`
          )
          .toArray() as Array<{ run_id: string; abort_mark: string | null }>;
        expect(marks).toEqual([
          { run_id: "cancelled-clean", abort_mark: null },
          { run_id: "cancelled-live", abort_mark: "cancel" }
        ]);
      }
    );
  });

  it("derives the definition identity for rows written before version 3", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        createV2RunsTable(state.storage);
        createLegacyStepTable(state.storage);
        const future = Date.now() + 60_000;
        for (const [runId, definition] of [
          ["plain", "checkpointing"],
          ["versioned", "chat@v2"],
          ["zero", "chat@v0"],
          ["not-a-version", "chat@vX"],
          ["inner", "chat@v2@v11"]
        ] as const) {
          seedLegacyRun(state.storage, {
            runId,
            definition,
            state: "waiting",
            waitReason: "sleep",
            nextAt: future
          });
        }
        await state.storage.put(VERSION_KEY, 2);

        await instance.lifecycle.start();

        const rows = state.storage.sql
          .exec(
            `SELECT run_id, definition_base, definition_version
             FROM cf_agents_task_runs ORDER BY run_id`
          )
          .toArray() as Array<{
          run_id: string;
          definition_base: string;
          definition_version: number;
        }>;
        expect(rows).toEqual([
          // The split takes the LAST `@v` followed only by digits...
          {
            run_id: "inner",
            definition_base: "chat@v2",
            definition_version: 11
          },
          {
            run_id: "not-a-version",
            definition_base: "chat@vX",
            definition_version: 0
          },
          {
            run_id: "plain",
            definition_base: "checkpointing",
            definition_version: 0
          },
          {
            run_id: "versioned",
            definition_base: "chat",
            definition_version: 2
          },
          // ...and only for a positive version, so `@v0` stays part of the base.
          { run_id: "zero", definition_base: "chat@v0", definition_version: 0 }
        ]);
      }
    );
  });

  it("copies a ledger larger than one batch, in batches, and drops the old table", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    const rows = 2_500;
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        createV2RunsTable(state.storage);
        createLegacyStepTable(state.storage);
        const now = Date.now();
        // One statement rather than 2 500: the point under test is the
        // rebuild's batching, not the seeding.
        state.storage.sql.exec(
          `INSERT INTO cf_agents_task_steps
             (run_id, step_name, kind, state, attempt, created_at, updated_at)
           WITH RECURSIVE n(i) AS (
             SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?
           )
           SELECT 'bulk-' || substr('000000' || i, -6), 'step', 'do',
                  'completed', 1, ?, ?
           FROM n`,
          rows,
          now,
          now
        );
        await state.storage.put(VERSION_KEY, 2);

        const schemaStamps = watchSchemaStamps(state.storage);
        const cursor = watchCursorWrites(state.storage);
        await instance.lifecycle.start();

        const copied = state.storage.sql
          .exec(
            `SELECT COUNT(*) AS count FROM cf_agents_task_journal WHERE turn = 0`
          )
          .toArray() as Array<{ count: number }>;
        expect(copied[0]?.count).toBe(rows);
        expect(tableNames(state.storage)).not.toContain("cf_agents_task_steps");
        expect(await state.storage.get(VERSION_KEY)).toBe(3);
        // The cursor is durable only while the rebuild is unfinished.
        expect(await state.storage.get(CURSOR_KEY)).toBeUndefined();
        // THIS object earns the intermediate stamp: a crash mid-copy has to
        // find the cursor and resume rather than restart.
        expect(schemaStamps).toEqual([2.5, 3]);
        // 2 500 rows at a batch of 2 000 is two batches, and each one
        // commits the key it reached inside its own transaction — the two
        // properties the intermediate version exists for. A rebuild that
        // copied everything in one statement, or that never persisted what
        // it had reached, fails here rather than at the next crash.
        expect(cursor.puts.map((value) => JSON.parse(value))).toEqual([
          { runId: "bulk-001999", name: "step" },
          { runId: "bulk-002499", name: "step" }
        ]);
        expect(cursor.deletes).toBe(1);
      }
    );
  });

  it("warns once when the retained ledger is large enough to be worth deleting", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    const rows = 10_001;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runInDurableObject(
        stub,
        async (instance: TaskHarnessObject, state) => {
          createV2RunsTable(state.storage);
          createLegacyStepTable(state.storage);
          const now = Date.now();
          state.storage.sql.exec(
            `INSERT INTO cf_agents_task_steps
               (run_id, step_name, kind, state, attempt, created_at, updated_at)
             WITH RECURSIVE n(i) AS (
               SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?
             )
             SELECT 'warn-' || substr('000000' || i, -6), 'step', 'do',
                    'completed', 1, ?, ?
             FROM n`,
            rows,
            now,
            now
          );
          await state.storage.put(VERSION_KEY, 2);

          await instance.lifecycle.start();

          const messages = warn.mock.calls.map((call) => String(call[0]));
          const rebuild = messages.filter((message) =>
            message.includes("retained step rows")
          );
          // One warning, not one per batch, and it names the call that
          // would have made the copy unnecessary.
          expect(rebuild).toHaveLength(1);
          expect(rebuild[0]).toContain(String(rows));
          expect(rebuild[0]).toContain("tasks.delete({ settledBefore })");
          expect(await state.storage.get(VERSION_KEY)).toBe(3);
        }
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("resumes an interrupted rebuild from its cursor without re-copying", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        // The state a crash mid-rebuild leaves: the intermediate version, a
        // cursor, the rows already copied, and the rest still in the old
        // table. The version 3 columns and tables are already in place —
        // they land before the cursor is first written.
        createV2RunsTable(state.storage);
        createLegacyStepTable(state.storage);
        const runId = "resumed";
        seedLegacyRun(state.storage, {
          runId,
          definition: "sleeper",
          input: { ms: 1 },
          state: "waiting",
          waitReason: "sleep",
          nextAt: Date.now() - 1_000
        });
        seedLegacyStep(state.storage, {
          runId,
          name: "nap",
          kind: "sleep",
          state: "waiting",
          nextAt: Date.now() - 1_000
        });
        // Sorts BELOW the cursor, so a resumed rebuild must never see it.
        // It is what makes the cursor observable: the real sequence would
        // have deleted it with the batch that copied it, and a rebuild that
        // restarted from scratch would copy it into the journal.
        seedLegacyStep(state.storage, {
          runId,
          name: "aaa",
          kind: "do",
          state: "completed",
          result: "aaa"
        });
        for (const column of [
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
        ]) {
          state.storage.sql.exec(
            `ALTER TABLE cf_agents_task_runs ADD COLUMN ${column}`
          );
        }
        state.storage.sql.exec(`
          CREATE TABLE cf_agents_task_journal (
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
            PRIMARY KEY (run_id, turn, name)
          ) WITHOUT ROWID`);
        const now = Date.now();
        // "before" was copied by the crashed start and deleted from the old
        // table; the cursor stopped exactly there.
        state.storage.sql.exec(
          `INSERT INTO cf_agents_task_journal
             (run_id, turn, name, kind, state, result, attempt, created_at,
              updated_at, completed_at)
           VALUES (?, 0, 'before', 'do', 'completed', ?, 1, ?, ?, ?)`,
          runId,
          JSON.stringify("before"),
          now,
          now,
          now
        );
        await state.storage.put(VERSION_KEY, 2.5);
        await state.storage.put(
          CURSOR_KEY,
          JSON.stringify({ runId, name: "before" })
        );

        // A run due at the intermediate version does not dispatch: a
        // half-copied journal must never be read by a replay. Without the
        // gate this claim lands and the replay writes a SECOND `nap` row
        // into the journal beside the one still waiting to be copied.
        await instance.tasks.onJob({
          job: {
            id: `task:${runId}`,
            capability: "tasks",
            fn: "wake",
            payload: { runId },
            time: Date.now()
          }
        } as unknown as Parameters<typeof instance.tasks.onJob>[0]);
        expect(instance.stepRuns).toEqual([]);
        expect(journalRows(state.storage)).toEqual([
          { run_id: runId, turn: 0, name: "before", state: "completed" }
        ]);
        expect(
          state.storage.sql
            .exec(
              "SELECT attempt, generation FROM cf_agents_task_runs WHERE run_id = ?",
              runId
            )
            .toArray()
        ).toEqual([{ attempt: 0, generation: null }]);

        await instance.lifecycle.start();

        // Resumed from the cursor: only the rows ABOVE it were copied.
        // "aaa" is below the cursor and stays uncopied — a rebuild that
        // ignored the cursor would have carried it in beside the rest.
        expect(journalRows(state.storage)).toEqual([
          { run_id: runId, turn: 0, name: "before", state: "completed" },
          { run_id: runId, turn: 0, name: "nap", state: "waiting" }
        ]);
        expect(tableNames(state.storage)).not.toContain("cf_agents_task_steps");
        expect(await state.storage.get(VERSION_KEY)).toBe(3);

        const snapshot = await waitForState(instance.tasks, runId, [
          "completed"
        ]);
        expect(snapshot.state).toBe("completed");
        expect(instance.stepRuns).toEqual(["sleeper:after"]);
      }
    );
  });
});
