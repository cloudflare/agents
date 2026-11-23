import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedTaskRun, type TaskHarnessObject } from "../capabilities/tasks";

const checkpointRows = (storage: DurableObjectStorage, runId: string) =>
  storage.sql
    .exec(
      "SELECT j.key AS key, j.value AS value FROM cf_agents_task_runs, json_each(checkpoint) j WHERE run_id = ?",
      runId
    )
    .toArray()
    .map((row) => ({
      key: row.key,
      value:
        typeof row.value === "string" ? row.value : JSON.stringify(row.value)
    }));

describe("Tasks local and checkpoint", () => {
  it("hands `local` to the first attempt in the caller's isolate", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      let open!: () => void;
      instance.rememberingGate = new Promise((resolve) => (open = resolve));
      const receipt = await instance.tasks.run("remembering", undefined, {
        local: { closure: "live" }
      });
      for (let i = 0; i < 50 && instance.rememberingSeen.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(instance.rememberingSeen).toEqual([
        { local: { closure: "live" }, note: null }
      ]);
      open();
      for (let i = 0; i < 50; i++) {
        if ((await instance.tasks.get(receipt.runId))?.status === "completed")
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect((await instance.tasks.get(receipt.runId))?.status).toBe(
        "completed"
      );
    });
  });

  it("gives `local` to the attempt the alarm claims while the caller still waits", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        const started = instance.tasks.run("remembering", undefined, {
          runId: "raced",
          start: "now",
          local: { closure: "live" }
        });
        // The wake is due as soon as the run is written: dispatch it before
        // the caller gets to claim the run.
        for (let i = 0; i < 100; i++) {
          const written = state.storage.sql
            .exec("SELECT 1 FROM cf_agents_task_runs WHERE run_id = 'raced'")
            .toArray().length;
          if (written) break;
          await Promise.resolve();
        }
        await (
          instance.tasks as unknown as {
            onJob(context: unknown): Promise<unknown>;
          }
        ).onJob({ job: { id: "task:raced", payload: { runId: "raced" } } });
        await started;
        expect(instance.rememberingSeen).toEqual([
          { local: { closure: "live" }, note: null }
        ]);
      }
    );
  });

  it("gives an attempt after a reset no `local`, and the checkpoint the last one wrote", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        // A run whose attempt died in an isolate that no longer exists,
        // after it wrote a note.
        seedTaskRun(state.storage, {
          runId: "reset-run",
          definition: "remembering",
          status: "running",
          generation: "dead-generation",
          attempt: 1,
          nextAt: Date.now() - 1000
        });
        state.storage.sql.exec(
          "UPDATE cf_agents_task_runs SET checkpoint = ? WHERE run_id = ?",
          JSON.stringify({ note: { attempt: 1 } }),
          "reset-run"
        );
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        for (let i = 0; i < 50; i++) {
          if ((await instance.tasks.get("reset-run"))?.status === "completed")
            break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(instance.rememberingSeen).toEqual([
          { local: undefined, note: { attempt: 1 } }
        ]);
        expect((await instance.tasks.get("reset-run"))?.status).toBe(
          "completed"
        );
        // Nothing reads a settled run's checkpoint: it is gone.
        expect(checkpointRows(state.storage, "reset-run")).toEqual([]);
      }
    );
  });

  it("drops a checkpoint write from an attempt a newer one superseded", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        let open!: () => void;
        instance.rememberingGate = new Promise((resolve) => (open = resolve));
        const receipt = await instance.tasks.run("remembering", undefined);
        for (let i = 0; i < 50 && instance.rememberingSeen.length === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(checkpointRows(state.storage, receipt.runId)).toEqual([
          { key: "note", value: JSON.stringify({ attempt: 1 }) }
        ]);
        // A newer attempt claimed the run while this one was parked.
        state.storage.sql.exec(
          "UPDATE cf_agents_task_runs SET generation = 'newer' WHERE run_id = ?",
          receipt.runId
        );
        open();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(checkpointRows(state.storage, receipt.runId)).toEqual([
          { key: "note", value: JSON.stringify({ attempt: 1 }) }
        ]);
      }
    );
  });
});

describe("Tasks schema 2", () => {
  it("renames stored run statuses in place, keeping every run", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        // The table as schema 1 left it, before Tasks starts here.
        state.storage.sql.exec(`
          CREATE TABLE cf_agents_task_runs (
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
          ) WITHOUT ROWID`);
        const later = Date.now() + 60 * 60 * 1000;
        const rows: Array<[string, string, string | null]> = [
          ["sleeping", "waiting", "sleep"],
          ["broken", "failed", null],
          ["stopped", "cancelled", null],
          ["done", "completed", null]
        ];
        for (const [runId, old, waitReason] of rows) {
          state.storage.sql.exec(
            `INSERT INTO cf_agents_task_runs
               (run_id, definition, state, wait_reason, next_at, error_name,
                error_message, cancel_reason, result, idempotency_key,
                created_at, updated_at, settled_at)
             VALUES (?, 'checkpointing', ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`,
            runId,
            old,
            waitReason,
            old === "waiting" ? later : null,
            old === "failed" ? "Error" : null,
            old === "failed" ? "boom" : null,
            old === "cancelled" ? "stop" : null,
            old === "completed" ? '"fin"' : null,
            `key-${runId}`,
            old === "waiting" ? null : 2
          );
        }
        await state.storage.put("cf_agents:tasks_schema_version", 1);

        await instance.lifecycle.start();

        expect(await instance.tasks.get("sleeping")).toMatchObject({
          status: "pending",
          waitReason: "sleep",
          wakeAt: later
        });
        expect(await instance.tasks.get("broken")).toMatchObject({
          status: "error",
          error: { name: "Error", message: "boom" }
        });
        expect(await instance.tasks.get("stopped")).toMatchObject({
          status: "aborted",
          reason: "stop"
        });
        expect(await instance.tasks.get("done")).toMatchObject({
          status: "completed",
          result: "fin"
        });
        // The unique key and the list index came across.
        expect(
          (await instance.tasks.getByIdempotencyKey("key-done"))?.runId
        ).toBe("done");
        expect(await state.storage.get("cf_agents:tasks_schema_version")).toBe(
          4
        );
        await instance.tasks.cancel("sleeping");
      }
    );
  });
});

describe("Tasks checkpoint column", () => {
  it("keeps any key as given, overwrites one in place, and clears the column at settle", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.tasks.run("oddKeys" as never, undefined as never, {
          runId: "odd",
          start: "now"
        });
        expect(instance.tasks.peek("odd")?.result).toEqual([
          { i: 0 },
          { i: 1 },
          { i: 2 },
          { i: 9 }
        ]);
        const [row] = state.storage.sql
          .exec<{ checkpoint: string | null }>(
            "SELECT checkpoint FROM cf_agents_task_runs WHERE run_id = 'odd'"
          )
          .toArray();
        expect(row.checkpoint).toBeNull();
      }
    );
  });
});

describe("Tasks schema 4", () => {
  it("moves schema 3's checkpoint rows into their run's column and drops the table", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        // As schema 3 left it: no column, a checkpoint table with rows.
        state.storage.sql.exec(
          "ALTER TABLE cf_agents_task_runs DROP COLUMN checkpoint"
        );
        state.storage.sql.exec(`
          CREATE TABLE cf_agents_task_checkpoint (
            run_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (run_id, key)
          ) WITHOUT ROWID`);
        state.storage.sql.exec(
          `INSERT INTO cf_agents_task_runs
             (run_id, definition, status, retain, attempt, cancel_requested,
              created_at, updated_at)
           VALUES ('old', 'remembering', 'pending', 1, 0, 0, 1, 1)`
        );
        for (const [key, value] of [
          ["note", { attempt: 1 }],
          ['odd."key', [1, 2]]
        ] as const) {
          state.storage.sql.exec(
            "INSERT INTO cf_agents_task_checkpoint VALUES ('old', ?, ?)",
            key,
            JSON.stringify(value)
          );
        }
        await state.storage.put("cf_agents:tasks_schema_version", 3);

        await instance.tasks.onStart();

        expect(
          state.storage.sql
            .exec(
              "SELECT name FROM sqlite_master WHERE name = 'cf_agents_task_checkpoint'"
            )
            .toArray()
        ).toEqual([]);
        const [row] = state.storage.sql
          .exec<{ checkpoint: string }>(
            "SELECT checkpoint FROM cf_agents_task_runs WHERE run_id = 'old'"
          )
          .toArray();
        expect(JSON.parse(row.checkpoint)).toEqual({
          note: { attempt: 1 },
          'odd."key': [1, 2]
        });
        expect(await state.storage.get("cf_agents:tasks_schema_version")).toBe(
          4
        );
      }
    );
  });
});

describe("Tasks schema 4, started again", () => {
  it("finishes the move on a start after one that added the column and failed", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        // As a failed schema-4 start leaves it: the column added, the old
        // table still there, the version still 3.
        state.storage.sql.exec(`
          CREATE TABLE cf_agents_task_checkpoint (
            run_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (run_id, key)
          ) WITHOUT ROWID`);
        state.storage.sql.exec(
          `INSERT INTO cf_agents_task_runs
             (run_id, definition, status, retain, attempt, cancel_requested,
              created_at, updated_at)
           VALUES ('again', 'remembering', 'pending', 1, 0, 0, 1, 1)`
        );
        state.storage.sql.exec(
          "INSERT INTO cf_agents_task_checkpoint VALUES ('again', 'note', '1')"
        );
        await state.storage.put("cf_agents:tasks_schema_version", 3);

        await instance.tasks.onStart();

        const [row] = state.storage.sql
          .exec<{ checkpoint: string }>(
            "SELECT checkpoint FROM cf_agents_task_runs WHERE run_id = 'again'"
          )
          .toArray();
        expect(JSON.parse(row.checkpoint)).toEqual({ note: 1 });
        expect(await state.storage.get("cf_agents:tasks_schema_version")).toBe(
          4
        );
      }
    );
  });
});

describe("Tasks wake while an attempt runs past its dispatch", () => {
  it("keeps the alarm within 5 s while the attempt executes, so a reset is noticed (#2847)", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      instance.rememberingGate = new Promise(() => {});
      await instance.tasks.run("remembering", undefined, {
        runId: "long",
        start: "alarm"
      });
    });
    // The dispatch returns at its 5 s budget with the attempt still going.
    await runDurableObjectAlarm(stub);
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        expect(instance.rememberingSeen).toHaveLength(1);
        expect((await instance.tasks.get("long"))?.status).toBe("running");
        const alarm = await state.storage.getAlarm();
        expect(alarm).not.toBeNull();
        expect(alarm!).toBeLessThanOrEqual(Date.now() + 5_000);
      }
    );
    // The next wake finds the attempt alive and comes back as soon.
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE cf_agents_jobs SET time = ? WHERE id = 'task:long'",
        Date.now() - 1
      );
    });
    const beforeWake = Date.now();
    await runDurableObjectAlarm(stub);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await runInDurableObject(stub, async (_instance, state) => {
      const alarm = await state.storage.getAlarm();
      // Moved forward by this wake, and no farther than 5 s.
      expect(alarm!).toBeGreaterThan(beforeWake);
      expect(alarm!).toBeLessThanOrEqual(Date.now() + 5_000);
    });
  }, 20_000);
});
