import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedTaskRun, type TaskHarnessObject } from "../capabilities/tasks";

const checkpointRows = (storage: DurableObjectStorage, runId: string) =>
  storage.sql
    .exec(
      "SELECT key, value FROM cf_agents_task_checkpoint WHERE run_id = ?",
      runId
    )
    .toArray();

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
          "INSERT INTO cf_agents_task_checkpoint (run_id, key, value) VALUES (?, ?, ?)",
          "reset-run",
          "note",
          JSON.stringify({ attempt: 1 })
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
          2
        );
        await instance.tasks.cancel("sleeping");
      }
    );
  });
});
