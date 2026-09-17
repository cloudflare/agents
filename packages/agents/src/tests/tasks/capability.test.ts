import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  backdateTaskWake,
  seedTaskRun,
  seedTaskStep,
  type TaskHarnessObject,
  type TaskSchedulerCoexistObject
} from "../capabilities/tasks";
import { captureDiagnosticsEvents } from "../shared/diagnostics-capture";
import { MAX_SERIALIZED_BYTES } from "../../tasks";
import type { Tasks, TaskRunSnapshot, TaskValue } from "../../tasks";

/**
 * Capability-level Tasks tests: the capability installed on a minimal real
 * Durable Object (`TaskHarnessObject`) through a real Lifecycle, driven by
 * real storage and real platform alarms — no fakes. Instance counters
 * separate real step execution from journal hits, which is how replay
 * memoization is proven.
 *
 * Imminent alarms auto-fire in workerd, so tests never assert that
 * `runDurableObjectAlarm` found one pending: parked states use far-future
 * deadlines to stay observable, wakes are forced by backdating them, and
 * outcomes are polled.
 */

function captureTaskEvents(name: string) {
  return captureDiagnosticsEvents("agents:task", name);
}

function routedWakeJobId(ownerKey: string, runId: string): string {
  return `task-routed:${JSON.stringify([ownerKey, runId])}`;
}

const ROUTED_WAKE_MIGRATION_VERSION_KEY = "cf_agents:tasks_routed_wake_version";

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

/** Poll until a condition holds. */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Tasks#register", () => {
  it("rejects a name without the reserved __cf prefix", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      expect(() =>
        instance.tasks.register("not-reserved", async () => undefined)
      ).toThrow(/"__cf"-prefixed reserved definition name/);
    });
  });

  it("rejects an empty name", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      expect(() => instance.tasks.register("", async () => undefined)).toThrow(
        /non-empty strings/
      );
    });
  });

  it("rejects a duplicate registration of the same name", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      instance.tasks.register("__cf_test_dup", async () => "first");
      expect(() =>
        instance.tasks.register("__cf_test_dup", async () => "second")
      ).toThrow(/already registered/);
    });
  });

  it("rejects a name that collides with a constructor-declared definition", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      // "pipeline" is declared in TaskHarnessObject's constructor `definitions`
      // map — not `__cf`-prefixed, so this hits the prefix check first, which
      // is fine: either failure mode correctly refuses the collision.
      expect(() =>
        instance.tasks.register("pipeline", async () => "shadowed")
      ).toThrow();
    });
  });

  it("dispatches a registered reserved definition through the internal aperture", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      instance.tasks.register("__cf_test_registered", async () => "ran");
      const receipt = await instance.tasks.__DO_NOT_USE_WILL_BREAK__runAttached(
        "__cf_test_registered",
        undefined
      );
      expect(receipt.accepted).toBe(true);
      expect((await instance.tasks.get(receipt.runId))?.state).toBe(
        "completed"
      );
      // The reserved name stays unreachable through the public surface.
      await expect(
        instance.tasks.run(
          "__cf_test_registered" as unknown as "pipeline",
          undefined as never
        )
      ).rejects.toThrow(/reserved "__cf" prefix/);
    });
  });
});

describe("Tasks capability", () => {
  it("migrates a v1 step journal without losing rows", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        // Simulate a crash after the v1 SQL committed but before its version
        // marker did. Startup must inspect SQLite instead of trusting KV.
        await state.storage.put("cf_agents:tasks_schema_version", 0);
        state.storage.sql.exec(`
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
          ) WITHOUT ROWID
        `);
        const now = Date.now();
        state.storage.sql.exec(
          `INSERT INTO cf_agents_task_steps
             (run_id, step_name, kind, state, attempt, created_at, updated_at,
              completed_at)
           VALUES ('old-run', 'old-step', 'sleep', 'completed', 0, ?, ?, ?)`,
          now,
          now,
          now
        );

        await instance.lifecycle.start();

        expect(await state.storage.get("cf_agents:tasks_schema_version")).toBe(
          2
        );
        expect(
          state.storage.sql
            .exec(
              "SELECT step_name, kind, state FROM cf_agents_task_steps WHERE run_id = 'old-run'"
            )
            .toArray()
        ).toEqual([
          { step_name: "old-step", kind: "sleep", state: "completed" }
        ]);
        state.storage.sql.exec(
          `INSERT INTO cf_agents_task_steps
             (run_id, step_name, kind, state, attempt, event_type,
              created_at, updated_at)
           VALUES ('new-run', 'event-step', 'wait_event', 'waiting', 0,
                   'approval', ?, ?)`,
          now,
          now
        );
        expect(
          state.storage.sql
            .exec(
              "SELECT name FROM sqlite_master WHERE name = 'cf_agents_task_events'"
            )
            .toArray()
        ).toHaveLength(1);
      }
    );
  });

  it("recovers when v2 SQL committed before its version marker", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());

    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        const now = Date.now();
        state.storage.sql.exec(
          `INSERT INTO cf_agents_task_steps
             (run_id, step_name, kind, state, attempt, event_type,
              created_at, updated_at)
           VALUES ('preserved-run', 'event-step', 'wait_event', 'waiting', 0,
                   'approval', ?, ?)`,
          now,
          now
        );

        // Simulate a crash after the step-table ALTER committed but before
        // the event table and durable version marker did.
        state.storage.sql.exec("DROP TABLE cf_agents_task_events");
        await state.storage.put("cf_agents:tasks_schema_version", 1);
      }
    );
    await evictDurableObject(stub);

    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();

        expect(await state.storage.get("cf_agents:tasks_schema_version")).toBe(
          2
        );
        expect(
          state.storage.sql
            .exec(
              `SELECT step_name, event_type
                 FROM cf_agents_task_steps
                WHERE run_id = 'preserved-run'`
            )
            .toArray()
        ).toEqual([{ step_name: "event-step", event_type: "approval" }]);
        expect(
          state.storage.sql
            .exec(
              `SELECT name, type
                 FROM sqlite_master
                WHERE name IN (
                  'cf_agents_task_events',
                  'cf_agents_task_events_available'
                )
                ORDER BY name`
            )
            .toArray()
        ).toEqual([
          { name: "cf_agents_task_events", type: "table" },
          { name: "cf_agents_task_events_available", type: "index" }
        ]);
      }
    );
  });

  it("accepts runs durably and deduplicates acceptance", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const first = await instance.tasks.run(
        "pipeline",
        { label: "a" },
        { idempotencyKey: "K" }
      );
      expect(first.accepted).toBe(true);
      expect(first.definition).toBe("pipeline");

      // The same idempotency key joins the existing run.
      const joined = await instance.tasks.run(
        "pipeline",
        { label: "a" },
        { idempotencyKey: "K" }
      );
      expect(joined.accepted).toBe(false);
      expect(joined.runId).toBe(first.runId);

      // A caller-selected run ID deduplicates the same way.
      const chosen = await instance.tasks.run(
        "pipeline",
        { label: "b" },
        { runId: "custom-run" }
      );
      expect(chosen.runId).toBe("custom-run");
      const again = await instance.tasks.run(
        "pipeline",
        { label: "b" },
        { runId: "custom-run" }
      );
      expect(again.accepted).toBe(false);

      // Reusing the key under a different definition is an error, not a join.
      await expect(
        instance.tasks.run("flaky", { label: "x" }, { idempotencyKey: "K" })
      ).rejects.toThrow(/already belongs to definition "pipeline"/);

      // A matching identifier pair joins; a run matched by ID with a
      // DIFFERENT stored key is a conflict, not a silent join.
      const both = await instance.tasks.run(
        "pipeline",
        { label: "a" },
        { runId: first.runId, idempotencyKey: "K" }
      );
      expect(both.accepted).toBe(false);
      await expect(
        instance.tasks.run(
          "pipeline",
          { label: "a" },
          { runId: first.runId, idempotencyKey: "other-key" }
        )
      ).rejects.toThrow(/conflicting key "other-key"/);
      // The key is the dedup authority: a fresh runId alongside a key that
      // names an existing run joins that run (a repeated delivery pattern —
      // new nonce, stable event key); the receipt carries the real id.
      const redelivered = await instance.tasks.run(
        "pipeline",
        { label: "a" },
        { runId: "some-other-id", idempotencyKey: "K" }
      );
      expect(redelivered.accepted).toBe(false);
      expect(redelivered.runId).toBe(first.runId);
      expect(await instance.tasks.get("some-other-id")).toBeNull();

      // Handles only see runs of their own definition.
      expect(await instance.tasks.handle("flaky").get(first.runId)).toBeNull();
      // ...and cannot cancel across definitions either.
      expect(await instance.tasks.handle("flaky").cancel(first.runId)).toBe(
        false
      );
      expect((await instance.tasks.get(first.runId))?.state).not.toBe(
        "cancelled"
      );
      expect(
        (await instance.tasks.handle("pipeline").getByIdempotencyKey("K"))
          ?.runId
      ).toBe(first.runId);

      const listed = await instance.tasks.list({ definition: "pipeline" });
      expect(listed.map((run) => run.runId)).toContain(first.runId);
    });
  });

  it("repairs a missing wake mirror when a retry joins an already-accepted run", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    const runId = "repair-wake-run";

    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run(
        "sleeper",
        { ms: 60 * 60 * 1000 },
        { runId }
      );
      expect(receipt.accepted).toBe(true);
      await waitForState(instance.tasks, runId, ["waiting"]);
    });

    // Simulate acceptance throwing after the row was already durably
    // inserted — the realistic failure is on the wake-mirror push itself,
    // not the insert — by deleting the mirror directly, as if it never
    // landed.
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM cf_agents_jobs WHERE id = ?",
        `task:${runId}`
      );
      const rows = state.storage.sql
        .exec(
          "SELECT COUNT(*) AS count FROM cf_agents_jobs WHERE id = ?",
          `task:${runId}`
        )
        .toArray();
      expect(rows[0]?.count).toBe(0);
    });

    // A retry that joins the existing run (same runId, the real caller
    // pattern for a redefer retry) must repair the missing wake, not just
    // report accepted:false against a run nothing will ever wake again.
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const joined = await instance.tasks.run(
        "sleeper",
        { ms: 60 * 60 * 1000 },
        { runId }
      );
      expect(joined.accepted).toBe(false);
    });

    await runInDurableObject(stub, async (_instance, state) => {
      const rows = state.storage.sql
        .exec(
          "SELECT COUNT(*) AS count FROM cf_agents_jobs WHERE id = ?",
          `task:${runId}`
        )
        .toArray();
      expect(rows[0]?.count).toBe(1);
    });
  });

  it("completes a run through the warm path with journaled steps and host context", async () => {
    const name = crypto.randomUUID();
    const stub = env.TaskHarnessObject.getByName(name);
    const capture = captureTaskEvents(name);

    try {
      await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
        const receipt = await instance.tasks.run("pipeline", {
          label: "warm"
        });
        const snapshot = await waitForState(instance.tasks, receipt.runId, [
          "completed"
        ]);
        if (snapshot.state !== "completed") throw new Error("unreachable");
        expect(snapshot.result).toEqual({
          first: "first:warm",
          second: "second:first:warm",
          hadHostContext: true
        });
        expect(instance.stepRuns).toEqual([
          "pipeline:first",
          "pipeline:second"
        ]);
      });
      expect(capture.events.map((event) => event.type)).toEqual([
        "task:accepted",
        "task:attempt:started",
        "task:step:started",
        "task:step:completed",
        "task:step:started",
        "task:step:completed",
        "task:completed"
      ]);
    } finally {
      capture.stop();
    }
  });

  it("leaves internal enqueues to their durable wake instead of warm-starting", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.__DO_NOT_USE_WILL_BREAK__enqueue(
        "pipeline",
        { label: "queued" }
      );
      expect((await instance.tasks.get(receipt.runId))?.state).toBe("pending");
      expect(instance.stepRuns).toEqual([]);
      await instance.tasks.cancel(receipt.runId);
    });
  });

  it("re-arms a lost physical alarm on startup when every wake mirror already matches", async () => {
    const name = crypto.randomUUID();
    const stub = env.TaskHarnessObject.getByName(name);
    const future = Date.now() + 60 * 60 * 1000;
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        seedTaskRun(state.storage, {
          runId: "lost-alarm",
          definition: "checkpointing",
          state: "pending",
          nextAt: future
        });
        // Bring the mirror to exactly what #syncWake writes, so the fresh
        // start below has nothing to push and must re-arm explicitly.
        state.storage.sql.exec(
          `UPDATE cf_agents_jobs SET retry_options = ? WHERE id = ?`,
          JSON.stringify({ maxAttempts: 1 }),
          "task:lost-alarm"
        );
        await state.storage.deleteAlarm();
        expect(await state.storage.getAlarm()).toBeNull();
      }
    );

    await evictDurableObject(stub);
    await runInDurableObject(
      env.TaskHarnessObject.getByName(name),
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        expect(await state.storage.getAlarm()).toBe(future);
        await instance.tasks.cancel("lost-alarm");
      }
    );
  });

  it("upgrades an existing Task wake to the one-attempt job policy", async () => {
    const name = crypto.randomUUID();
    const stub = env.TaskHarnessObject.getByName(name);
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        seedTaskRun(state.storage, {
          runId: "old-wake-policy",
          definition: "checkpointing",
          state: "pending",
          nextAt: Date.now() + 60 * 60 * 1000
        });
      }
    );

    await evictDurableObject(stub);
    const fresh = env.TaskHarnessObject.getByName(name);
    await runInDurableObject(
      fresh,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        const rows = state.storage.sql
          .exec(
            `SELECT fn, retry_options FROM cf_agents_jobs
             WHERE id = 'task:old-wake-policy'`
          )
          .toArray() as Array<{
          fn: string;
          retry_options: string | null;
        }>;
        expect(rows[0]?.fn).toBe("wake");
        expect(JSON.parse(rows[0]?.retry_options ?? "null")).toEqual({
          maxAttempts: 1
        });
        await instance.tasks.cancel("old-wake-policy");
      }
    );
  });

  it("keeps local and routed wake IDs isolated", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    const owner = {
      key: "Parent:root/Child:alice",
      data: JSON.stringify([
        { className: "Parent", name: "root" },
        { className: "Child", name: "alice" }
      ])
    };
    const routedRunId = "approval";
    const localRunId = `${owner.key}:${routedRunId}`;

    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run(
          "sleeper",
          { ms: 60 * 60 * 1000 },
          { runId: localRunId }
        );
        await waitForState(instance.tasks, receipt.runId, ["waiting"]);

        await instance.tasks.onRoute({
          source: owner,
          payload: {
            type: "syncWake",
            runId: routedRunId,
            next: Date.now() + 30 * 60 * 1000
          }
        });

        const localJobId = `task:${localRunId}`;
        const routedJobId = routedWakeJobId(owner.key, routedRunId);
        expect(
          state.storage.sql
            .exec(
              "SELECT id FROM cf_agents_jobs WHERE id IN (?, ?) ORDER BY id",
              localJobId,
              routedJobId
            )
            .toArray()
        ).toEqual([{ id: routedJobId }, { id: localJobId }]);

        await instance.tasks.onRoute({
          source: owner,
          payload: { type: "syncWake", runId: routedRunId, next: null }
        });
        expect(
          state.storage.sql
            .exec("SELECT id FROM cf_agents_jobs WHERE id = ?", localJobId)
            .toArray()
        ).toEqual([{ id: localJobId }]);
        await instance.tasks.cancel(localRunId);
      }
    );
  });

  it("cleans one routed owner subtree without touching a sibling", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    const victim = {
      key: "Parent:root/Child:alice",
      data: JSON.stringify([
        { className: "Parent", name: "root" },
        { className: "Child", name: "alice" }
      ])
    };
    const descendant = {
      key: `${victim.key}/Grandchild:leaf`,
      data: JSON.stringify([
        { className: "Parent", name: "root" },
        { className: "Child", name: "alice" },
        { className: "Grandchild", name: "leaf" }
      ])
    };
    const sibling = {
      key: "Parent:root/Child:alice-sibling",
      data: JSON.stringify([
        { className: "Parent", name: "root" },
        { className: "Child", name: "alice-sibling" }
      ])
    };
    const next = Date.now() + 60_000;

    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        for (const [source, runId] of [
          [victim, "victim-run"],
          [descendant, "descendant-run"],
          [sibling, "sibling-run"]
        ] as const) {
          await instance.tasks.onRoute({
            source,
            payload: { type: "syncWake", runId, next }
          });
        }

        await instance.tasks.__DO_NOT_USE_WILL_BREAK__cleanupRoutePrefix(
          victim.key
        );
        expect(
          state.storage.sql
            .exec(
              `SELECT id FROM cf_agents_jobs
                WHERE capability = 'tasks'
                ORDER BY id`
            )
            .toArray()
        ).toEqual([{ id: routedWakeJobId(sibling.key, "sibling-run") }]);

        await instance.tasks.onRoute({
          source: sibling,
          payload: { type: "syncWake", runId: "sibling-run", next: null }
        });
      }
    );
  });

  it("refreshes routed transport data without changing stable wake identity", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    const path = [
      { className: "Parent", name: "root" },
      { className: "Child", name: "alice" }
    ];
    const owner = {
      key: "Parent:root/Child:alice",
      data: JSON.stringify(path)
    };
    const updatedOwner = {
      key: owner.key,
      data: JSON.stringify(
        path.map(({ className, name }) => ({ name, className }))
      )
    };
    const runId = "approval";
    const wakeAt = Date.now() + 30 * 60 * 1000;

    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        await instance.tasks.onRoute({
          source: owner,
          payload: { type: "syncWake", runId, next: wakeAt }
        });
        await expect(
          instance.tasks.onRoute({
            source: updatedOwner,
            payload: { type: "syncWake", runId, next: wakeAt }
          })
        ).resolves.toBe(true);

        const rows = state.storage.sql
          .exec(
            "SELECT payload FROM cf_agents_jobs WHERE id = ?",
            routedWakeJobId(owner.key, runId)
          )
          .toArray() as Array<{ payload: string }>;
        expect(JSON.parse(rows[0]?.payload ?? "null")).toMatchObject({
          runId,
          owner_path: updatedOwner.data,
          owner_path_key: owner.key
        });

        await instance.tasks.onRoute({
          source: updatedOwner,
          payload: { type: "syncWake", runId, next: null }
        });
      }
    );
  });

  it("migrates a legacy routed wake before repairing its aliased local wake", async () => {
    const name = crypto.randomUUID();
    const stub = env.TaskHarnessObject.getByName(name);
    const owner = {
      key: "Parent:root/Child:alice",
      data: JSON.stringify([
        { className: "Parent", name: "root" },
        { className: "Child", name: "alice" }
      ])
    };
    const routedRunId = "approval";
    const localRunId = `${owner.key}:${routedRunId}`;
    const legacyJobId = `task:${localRunId}`;
    let wakeAt = 0;

    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run(
          "sleeper",
          { ms: 60 * 60 * 1000 },
          { runId: localRunId }
        );
        const parked = await waitForState(instance.tasks, receipt.runId, [
          "waiting"
        ]);
        if (
          parked.state !== "waiting" ||
          !("wakeAt" in parked) ||
          typeof parked.wakeAt !== "number"
        ) {
          throw new Error("expected timed wait");
        }
        wakeAt = parked.wakeAt;

        // Simulate the legacy routed mirror replacing an aliased local row.
        state.storage.sql.exec(
          "UPDATE cf_agents_jobs SET payload = ? WHERE id = ?",
          JSON.stringify({
            runId: routedRunId,
            owner_path: owner.data,
            owner_path_key: owner.key
          }),
          legacyJobId
        );
        // More than one migration batch of local wakes proves startup scans
        // only bounded ID pages before loading candidate payloads.
        state.storage.sql.exec(
          `WITH RECURSIVE numbers(value) AS (
             SELECT 0
             UNION ALL
             SELECT value + 1 FROM numbers WHERE value < 100
           )
           INSERT INTO cf_agents_jobs
             (id, capability, fn, time, payload, retry_options)
           SELECT printf('task:%03d', value), 'tasks', 'wake', ?,
                  json_object('runId', printf('scan-%03d', value)), ?
           FROM numbers`,
          wakeAt + 60 * 60 * 1000,
          JSON.stringify({ maxAttempts: 1 })
        );
        await state.storage.delete(ROUTED_WAKE_MIGRATION_VERSION_KEY);
        await state.storage.deleteAlarm();
      }
    );

    await evictDurableObject(stub);
    await runInDurableObject(
      env.TaskHarnessObject.getByName(name),
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        const routedJobId = routedWakeJobId(owner.key, routedRunId);
        expect(
          state.storage.sql
            .exec(
              "SELECT id FROM cf_agents_jobs WHERE id IN (?, ?) ORDER BY id",
              legacyJobId,
              routedJobId
            )
            .toArray()
        ).toEqual([{ id: routedJobId }, { id: legacyJobId }]);
        expect(await state.storage.getAlarm()).toBe(wakeAt);

        await state.storage.deleteAlarm();
        await instance.tasks.onRoute({
          source: owner,
          payload: { type: "syncWake", runId: routedRunId, next: wakeAt }
        });
        expect(await state.storage.getAlarm()).toBe(wakeAt);

        await instance.tasks.onRoute({
          source: owner,
          payload: { type: "syncWake", runId: routedRunId, next: null }
        });
        await instance.tasks.cancel(localRunId);
      }
    );
  });

  it("finishes an interrupted routed wake migration idempotently", async () => {
    const name = crypto.randomUUID();
    const stub = env.TaskHarnessObject.getByName(name);
    const owner = {
      key: "Parent:root/Child:bob",
      data: JSON.stringify([
        { className: "Parent", name: "root" },
        { className: "Child", name: "bob" }
      ])
    };
    const runId = "review";
    const wakeAt = Date.now() + 30 * 60 * 1000;
    const jobId = routedWakeJobId(owner.key, runId);
    const legacyJobId = `task:${owner.key}:${runId}`;

    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        await instance.tasks.onRoute({
          source: owner,
          payload: { type: "syncWake", runId, next: wakeAt }
        });
        state.storage.sql.exec(
          `INSERT INTO cf_agents_jobs
             (id, capability, fn, time, payload, retry_options)
           SELECT ?, capability, fn, time, payload, retry_options
           FROM cf_agents_jobs WHERE id = ?`,
          legacyJobId,
          jobId
        );
        await state.storage.delete(ROUTED_WAKE_MIGRATION_VERSION_KEY);
        await state.storage.deleteAlarm();
      }
    );

    await evictDurableObject(stub);
    await runInDurableObject(
      env.TaskHarnessObject.getByName(name),
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        expect(
          state.storage.sql
            .exec(
              "SELECT id FROM cf_agents_jobs WHERE id IN (?, ?)",
              legacyJobId,
              jobId
            )
            .toArray()
        ).toEqual([{ id: jobId }]);
        expect(await state.storage.getAlarm()).toBe(wakeAt);
        await instance.tasks.onRoute({
          source: owner,
          payload: { type: "syncWake", runId, next: null }
        });
      }
    );
  });

  it("parks on a step retry and replays without re-executing completed steps", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());

    const runId = await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject) => {
        instance.failuresBeforeSuccess = 1;
        const receipt = await instance.tasks.run("flaky", { label: "r" });
        const parked = await waitForState(instance.tasks, receipt.runId, [
          "waiting"
        ]);
        if (parked.state !== "waiting") throw new Error("unreachable");
        expect(parked.reason).toBe("retry");
        expect(instance.stepRuns).toEqual(["flaky:seed", "flaky:unstable:1"]);
        return receipt.runId;
      }
    );

    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        backdateTaskWake(state.storage, runId, "unstable");
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const snapshot = await waitForState(instance.tasks, runId, ["completed"]);
      if (snapshot.state !== "completed") throw new Error("unreachable");
      expect(snapshot.result).toBe("r-seed-ok");
      // The seed step ran once; only the unstable step executed twice.
      expect(instance.stepRuns).toEqual([
        "flaky:seed",
        "flaky:unstable:1",
        "flaky:unstable:2"
      ]);
    });
  });

  it("reclaims an interrupted attempt and replays from the journal", async () => {
    const name = crypto.randomUUID();
    const stub = env.TaskHarnessObject.getByName(name);
    const capture = captureTaskEvents(name);

    try {
      await runInDurableObject(
        stub,
        async (instance: TaskHarnessObject, state) => {
          await instance.lifecycle.start();
          // A run claimed by an isolate that no longer exists: state running,
          // a dead generation, and one journaled step with a sentinel value a
          // live execution could never produce.
          seedTaskRun(state.storage, {
            runId: "interrupted-run",
            definition: "pipeline",
            input: { label: "live" },
            state: "running",
            generation: "dead-generation",
            attempt: 1,
            nextAt: Date.now() - 1000
          });
          seedTaskStep(state.storage, {
            runId: "interrupted-run",
            name: "first",
            kind: "do",
            state: "completed",
            result: "first:JOURNAL"
          });
          await instance.lifecycle.rearmAlarm();
        }
      );

      await runDurableObjectAlarm(stub);

      await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
        const snapshot = await waitForState(instance.tasks, "interrupted-run", [
          "completed"
        ]);
        if (snapshot.state !== "completed") throw new Error("unreachable");
        // The journaled sentinel flowed into the rest of the replay: the
        // completed step was not re-executed.
        expect(snapshot.result).toEqual({
          first: "first:JOURNAL",
          second: "second:first:JOURNAL",
          hadHostContext: true
        });
        expect(instance.stepRuns).toEqual(["pipeline:second"]);
      });
      expect(capture.events.map((event) => event.type)).toContain(
        "task:attempt:interrupted"
      );
    } finally {
      capture.stop();
    }
  });

  it("sleeps durably, keeps the first recorded deadline, and resumes after it", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());

    const { runId, firstWake } = await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run("sleeper", { ms: 60_000 });
        const parked = await waitForState(instance.tasks, receipt.runId, [
          "waiting"
        ]);
        if (parked.state !== "waiting") throw new Error("unreachable");
        expect(parked.reason).toBe("sleep");
        // The physical alarm settles on the sleep deadline.
        await waitFor(
          async () => (await state.storage.getAlarm()) === parked.wakeAt
        );
        return { runId: receipt.runId, firstWake: parked.wakeAt };
      }
    );

    // Wake the run before its sleep deadline: it replays up to the sleep and
    // parks again without moving the recorded deadline.
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        backdateTaskWake(state.storage, runId);
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);

    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await waitFor(() => {
          const [row] = state.storage.sql
            .exec(
              "SELECT attempt, state FROM cf_agents_task_runs WHERE run_id = ?",
              runId
            )
            .toArray();
          return row?.attempt === 2 && row?.state === "waiting";
        });
        const parked = await instance.tasks.get(runId);
        if (parked?.state !== "waiting") throw new Error("expected waiting");
        expect(parked.wakeAt).toBe(firstWake);
        expect(instance.stepRuns).toEqual(["sleeper:before"]);

        backdateTaskWake(state.storage, runId, "nap");
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const snapshot = await waitForState(instance.tasks, runId, ["completed"]);
      if (snapshot.state !== "completed") throw new Error("unreachable");
      expect(snapshot.result).toBe("done");
      expect(instance.stepRuns).toEqual(["sleeper:before", "sleeper:after"]);
    });
  });

  it("buffers an event, wakes an indefinite wait, and consumes it once", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run("eventWaiter", {
          type: "approval"
        });
        const parked = await waitForState(instance.tasks, receipt.runId, [
          "waiting"
        ]);
        if (parked.state !== "waiting" || parked.reason !== "event") {
          throw new Error("expected event wait");
        }
        expect("wakeAt" in parked).toBe(false);
        expect(
          state.storage.sql
            .exec(
              "SELECT id FROM cf_agents_jobs WHERE id = ?",
              `task:${receipt.runId}`
            )
            .toArray()
        ).toEqual([]);

        await instance.tasks.sendEvent(receipt.runId, "Approval", {
          value: "wrong case"
        });
        expect((await instance.tasks.get(receipt.runId))?.state).toBe(
          "waiting"
        );

        const sent = await instance.tasks.sendEvent(
          receipt.runId,
          "approval",
          { value: "yes" },
          { idempotencyKey: "approval:1" }
        );
        expect(sent.accepted).toBe(true);

        const completed = await waitForState(instance.tasks, receipt.runId, [
          "completed"
        ]);
        if (completed.state !== "completed") throw new Error("unreachable");
        expect(completed.result).toEqual({
          eventId: sent.eventId,
          type: "approval",
          payload: { value: "yes" },
          createdAt: sent.createdAt
        });
        const [event] = state.storage.sql
          .exec(
            "SELECT consumed_step_name FROM cf_agents_task_events WHERE event_id = ?",
            sent.eventId
          )
          .toArray();
        expect(event?.consumed_step_name).toBe("incoming");
      }
    );
  });

  it("buffers events during work without interrupting the active step", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("eventDuringWork");
      await waitFor(() => instance.releaseEventWork !== undefined);

      const sent = await instance.tasks.sendEvent(receipt.runId, "approval", {
        value: "buffered"
      });
      expect((await instance.tasks.get(receipt.runId))?.state).toBe("running");
      expect(instance.stepRuns).toEqual(["eventDuringWork:work"]);

      instance.releaseEventWork?.();
      const completed = await waitForState(instance.tasks, receipt.runId, [
        "completed"
      ]);
      if (completed.state !== "completed") throw new Error("unreachable");
      expect(completed.result).toMatchObject({
        eventId: sent.eventId,
        payload: { value: "buffered" }
      });
    });
  });

  it("does not strand an event delivered while the run is parking", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const runId = `event-before-park-${crypto.randomUUID()}`;
        await instance.tasks.run("eventBeforePark", { runId }, { runId });

        const completed = await waitForState(instance.tasks, runId, [
          "completed"
        ]);
        if (completed.state !== "completed") throw new Error("unreachable");
        expect(completed.result).toMatchObject({
          type: "approval",
          payload: { value: "accepted" }
        });
        expect(
          state.storage.sql
            .exec(
              `SELECT consumed_step_name
                 FROM cf_agents_task_events
                WHERE run_id = ?`,
              runId
            )
            .toArray()
        ).toEqual([{ consumed_step_name: "incoming" }]);
      }
    );
  });

  it("times out an event wait durably", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    let runId = "";
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run("eventTimeout");
        runId = receipt.runId;
        const parked = await waitForState(instance.tasks, runId, ["waiting"]);
        if (parked.state !== "waiting") throw new Error("unreachable");
        expect(parked.reason).toBe("event");
        expect(parked.wakeAt).toBeTypeOf("number");
        backdateTaskWake(state.storage, runId, "incoming");
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const completed = await waitForState(instance.tasks, runId, [
        "completed"
      ]);
      if (completed.state !== "completed") throw new Error("unreachable");
      expect(completed.result).toBeNull();
    });
  });

  it("consumes an on-time event even when replay starts after the deadline", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    let runId = "";
    let eventId = "";
    let deadline = 0;

    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run("eventTimeout");
        runId = receipt.runId;
        await waitForState(instance.tasks, runId, ["waiting"]);
        backdateTaskWake(state.storage, runId, "incoming");

        const [step] = state.storage.sql
          .exec(
            `SELECT next_at
               FROM cf_agents_task_steps
              WHERE run_id = ? AND step_name = 'incoming'`,
            runId
          )
          .toArray();
        if (typeof step?.next_at !== "number") {
          throw new Error("expected a timed event step");
        }
        deadline = step.next_at;
        eventId = `on-time-${crypto.randomUUID()}`;
        const payload = { value: "on time" };
        const event = {
          eventId,
          type: "approval",
          payload,
          createdAt: deadline
        };
        const serializedSize = new TextEncoder().encode(
          JSON.stringify(event)
        ).byteLength;
        state.storage.sql.exec(
          `INSERT INTO cf_agents_task_events
             (event_id, run_id, type, payload, serialized_size, created_at)
           VALUES (?, ?, 'approval', ?, ?, ?)`,
          eventId,
          runId,
          JSON.stringify(payload),
          serializedSize,
          deadline
        );
        await instance.lifecycle.rearmAlarm();
      }
    );

    await runDurableObjectAlarm(stub);
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const completed = await waitForState(instance.tasks, runId, [
          "completed"
        ]);
        if (completed.state !== "completed") throw new Error("unreachable");
        expect(completed.result).toEqual({
          eventId,
          type: "approval",
          payload: { value: "on time" },
          createdAt: deadline
        });
        const [event] = state.storage.sql
          .exec(
            `SELECT consumed_step_name, consumed_at
               FROM cf_agents_task_events
              WHERE event_id = ?`,
            eventId
          )
          .toArray();
        expect(event?.consumed_step_name).toBe("incoming");
        expect(event?.consumed_at).toBeGreaterThan(deadline);
      }
    );
  });

  it("does not consume an event accepted after a timed wait deadline", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    let runId = "";
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run("eventTimeout");
        runId = receipt.runId;
        await waitForState(instance.tasks, runId, ["waiting"]);
        backdateTaskWake(state.storage, runId, "incoming");
        const late = await instance.tasks.sendEvent(runId, "approval", {
          value: "late"
        });
        expect(late.accepted).toBe(true);
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const completed = await waitForState(instance.tasks, runId, [
          "completed"
        ]);
        if (completed.state !== "completed") throw new Error("unreachable");
        expect(completed.result).toBeNull();
        expect(
          state.storage.sql
            .exec(
              "SELECT consumed_at FROM cf_agents_task_events WHERE run_id = ?",
              runId
            )
            .toArray()
        ).toEqual([{ consumed_at: null }]);
      }
    );
  });

  it("rejects an event whose envelope cannot fit in the journal", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run("eventWaiter", {
          type: "chunk"
        });
        await waitForState(instance.tasks, receipt.runId, ["waiting"]);
        const payload = "x".repeat(MAX_SERIALIZED_BYTES - 2);
        await expect(
          instance.tasks.sendEvent(receipt.runId, "chunk", payload)
        ).rejects.toMatchObject({ name: "TaskSerializationError" });
        expect(
          state.storage.sql
            .exec(
              "SELECT event_id FROM cf_agents_task_events WHERE run_id = ?",
              receipt.runId
            )
            .toArray()
        ).toEqual([]);
      }
    );
  });

  it("rejects non-finite event numbers and oversized idempotency keys", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("eventWaiter", {
        type: "value"
      });
      await waitForState(instance.tasks, receipt.runId, ["waiting"]);
      await expect(
        instance.tasks.sendEvent(receipt.runId, "value", {
          nested: [Number.POSITIVE_INFINITY]
        })
      ).rejects.toMatchObject({ name: "TaskSerializationError" });
      await expect(
        instance.tasks.sendEvent(
          receipt.runId,
          "value",
          { value: 1 },
          { idempotencyKey: "x".repeat(257) }
        )
      ).rejects.toThrow(/exceeds 256 characters/);
    });
  });

  it("bounds event batches by journal size before consuming them", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    let runId = "";
    const chunk = "x".repeat(600_000);
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run("eventSizedDrain");
        runId = receipt.runId;
        await waitForState(instance.tasks, runId, ["waiting"]);
        await instance.tasks.sendEvent(runId, "chunk", chunk);
        await instance.tasks.sendEvent(runId, "chunk", chunk);
        backdateTaskWake(state.storage, runId, "gate");
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const completed = await waitForState(instance.tasks, runId, [
          "completed"
        ]);
        if (completed.state !== "completed") throw new Error("unreachable");
        expect(completed.result).toEqual([chunk.length]);
        expect(
          state.storage.sql
            .exec(
              `SELECT COUNT(*) AS count FROM cf_agents_task_events
               WHERE run_id = ? AND consumed_at IS NULL`,
              runId
            )
            .one().count
        ).toBe(1);
      }
    );
  });

  it("repairs a post-commit wake failure with an idempotent retry", async () => {
    const name = crypto.randomUUID();
    const stub = env.TaskHarnessObject.getByName(name);
    const capture = captureTaskEvents(name);
    try {
      await runInDurableObject(
        stub,
        async (instance: TaskHarnessObject, state) => {
          const receipt = await instance.tasks.run("eventWaiter", {
            type: "approval"
          });
          await waitForState(instance.tasks, receipt.runId, ["waiting"]);

          state.storage.sql.exec(`
            CREATE TRIGGER fail_event_wake
            BEFORE INSERT ON cf_agents_jobs
            WHEN NEW.id = 'task:${receipt.runId}'
            BEGIN
              SELECT RAISE(ABORT, 'forced wake failure');
            END
          `);
          await expect(
            instance.tasks.sendEvent(
              receipt.runId,
              "approval",
              { value: "yes" },
              { idempotencyKey: "approval:repair" }
            )
          ).rejects.toThrow(/forced wake failure/);

          const [event] = state.storage.sql
            .exec(
              `SELECT event_id, created_at FROM cf_agents_task_events
               WHERE run_id = ?`,
              receipt.runId
            )
            .toArray() as Array<{ event_id: string; created_at: number }>;
          if (!event) throw new Error("event was not committed");
          expect(
            capture.events.filter(
              (captured) => captured.type === "task:event:received"
            )
          ).toHaveLength(1);
          state.storage.sql.exec("DROP TRIGGER fail_event_wake");

          const retried = await instance.tasks.sendEvent(
            receipt.runId,
            "approval",
            { value: "yes" },
            { idempotencyKey: "approval:repair" }
          );
          expect(retried).toEqual({
            eventId: event.event_id,
            type: "approval",
            payload: { value: "yes" },
            createdAt: event.created_at,
            accepted: false
          });

          const completed = await waitForState(instance.tasks, receipt.runId, [
            "completed"
          ]);
          if (completed.state !== "completed") throw new Error("unreachable");
          expect(completed.result).toMatchObject({ eventId: event.event_id });

          const terminalRetry = await instance.tasks.sendEvent(
            receipt.runId,
            "approval",
            { value: "yes" },
            { idempotencyKey: "approval:repair" }
          );
          expect(terminalRetry).toEqual(retried);
          expect(
            capture.events.filter(
              (captured) => captured.type === "task:event:received"
            )
          ).toHaveLength(1);
        }
      );
    } finally {
      capture.stop();
    }
  });

  it("rolls back event consumption when journaling fails", async () => {
    const name = crypto.randomUUID();
    const stub = env.TaskHarnessObject.getByName(name);
    const capture = captureTaskEvents(name);
    let runId = "";
    let eventId = "";

    try {
      await runInDurableObject(
        stub,
        async (instance: TaskHarnessObject, state) => {
          const receipt = await instance.tasks.run("eventWaiter", {
            type: "approval"
          });
          runId = receipt.runId;
          await waitForState(instance.tasks, runId, ["waiting"]);

          state.storage.sql.exec(`
          CREATE TRIGGER fail_event_journal
          BEFORE UPDATE OF state ON cf_agents_task_steps
          WHEN NEW.run_id = '${runId}'
            AND NEW.step_name = 'incoming'
            AND NEW.state = 'completed'
            AND EXISTS (
              SELECT 1 FROM cf_agents_task_events
              WHERE run_id = NEW.run_id
                AND consumed_step_name = NEW.step_name
                AND consumed_at IS NOT NULL
            )
          BEGIN
            SELECT RAISE(ABORT, 'Network connection lost.');
          END
        `);
          const sent = await instance.tasks.sendEvent(runId, "approval", {
            value: "retry me"
          });
          eventId = sent.eventId;

          let threw = false;
          try {
            await (instance as unknown as { alarm(): Promise<void> }).alarm();
          } catch (error) {
            threw =
              error instanceof Error &&
              error.message.includes("Network connection lost");
          }
          expect(threw).toBe(true);
          expect((await instance.tasks.get(runId))?.state).toBe("running");
          expect(instance.runErrors).toEqual([]);
          expect(
            state.storage.sql
              .exec(
                `SELECT consumed_step_name, consumed_at
                 FROM cf_agents_task_events
                WHERE event_id = ?`,
                eventId
              )
              .toArray()
          ).toEqual([{ consumed_step_name: null, consumed_at: null }]);
          expect(
            state.storage.sql
              .exec(
                `SELECT state, result
                  FROM cf_agents_task_steps
                 WHERE run_id = ? AND step_name = 'incoming'`,
                runId
              )
              .toArray()
          ).toEqual([{ state: "waiting", result: null }]);
          expect(
            capture.events.filter(
              (event) => event.type === "task:event:consumed"
            )
          ).toEqual([]);

          state.storage.sql.exec("DROP TRIGGER fail_event_journal");
          backdateTaskWake(state.storage, runId);
          await instance.lifecycle.rearmAlarm();
        }
      );

      await runDurableObjectAlarm(stub);
      await runInDurableObject(
        stub,
        async (instance: TaskHarnessObject, state) => {
          const completed = await waitForState(instance.tasks, runId, [
            "completed"
          ]);
          if (completed.state !== "completed") throw new Error("unreachable");
          expect(completed.result).toMatchObject({
            eventId,
            payload: { value: "retry me" }
          });
          const [event] = state.storage.sql
            .exec(
              `SELECT consumed_step_name, consumed_at
                 FROM cf_agents_task_events
                WHERE event_id = ?`,
              eventId
            )
            .toArray();
          expect(event?.consumed_step_name).toBe("incoming");
          expect(event?.consumed_at).toBeTypeOf("number");
          expect(
            capture.events
              .filter((event) => event.type === "task:event:consumed")
              .map((event) => event.payload)
          ).toEqual([
            {
              runId,
              definition: "eventWaiter",
              step: "incoming",
              type: "approval",
              count: 1,
              eventIds: [eventId]
            }
          ]);
        }
      );
    } finally {
      capture.stop();
    }
  });

  it("takes buffered events FIFO in bounded, consume-once batches", async () => {
    const name = crypto.randomUUID();
    const stub = env.TaskHarnessObject.getByName(name);
    const capture = captureTaskEvents(name);
    let runId = "";
    let eventIds: string[] = [];
    try {
      await runInDurableObject(
        stub,
        async (instance: TaskHarnessObject, state) => {
          const receipt = await instance.tasks.run("eventDrain");
          runId = receipt.runId;
          await waitForState(instance.tasks, runId, ["waiting"]);
          const first = await instance.tasks.sendEvent(runId, "item", {
            value: 1
          });
          await instance.tasks.sendEvent(runId, "other", { value: 9 });
          const second = await instance.tasks.sendEvent(runId, "item", {
            value: 2
          });
          const third = await instance.tasks.sendEvent(runId, "item", {
            value: 3
          });
          eventIds = [first.eventId, second.eventId, third.eventId];
          backdateTaskWake(state.storage, runId, "gate");
          await instance.lifecycle.rearmAlarm();
        }
      );
      await runDurableObjectAlarm(stub);
      await runInDurableObject(
        stub,
        async (instance: TaskHarnessObject, state) => {
          const completed = await waitForState(instance.tasks, runId, [
            "completed"
          ]);
          if (completed.state !== "completed") throw new Error("unreachable");
          expect(completed.result).toMatchObject({
            first: [{ payload: { value: 1 } }, { payload: { value: 2 } }],
            second: [{ payload: { value: 3 } }]
          });
          const available = state.storage.sql
            .exec(
              "SELECT type FROM cf_agents_task_events WHERE run_id = ? AND consumed_at IS NULL",
              runId
            )
            .toArray();
          expect(available).toEqual([{ type: "other" }]);

          expect(
            capture.events
              .filter((event) => event.type === "task:event:consumed")
              .map((event) => event.payload)
          ).toEqual([
            {
              runId,
              definition: "eventDrain",
              step: "first-batch",
              type: "item",
              count: 2,
              eventIds: eventIds.slice(0, 2)
            },
            {
              runId,
              definition: "eventDrain",
              step: "second-batch",
              type: "item",
              count: 1,
              eventIds: eventIds.slice(2)
            }
          ]);
        }
      );
    } finally {
      capture.stop();
    }
  });

  it("replays a journaled event take without consuming later arrivals", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    let runId = "";
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        instance.failuresBeforeSuccess = 1;
        const receipt = await instance.tasks.run("eventReplay");
        runId = receipt.runId;
        await waitForState(instance.tasks, runId, ["waiting"]);
        await instance.tasks.sendEvent(runId, "item", { value: 1 });
        await instance.tasks.sendEvent(runId, "item", { value: 2 });
        backdateTaskWake(state.storage, runId, "gate");
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const parked = await waitForState(instance.tasks, runId, ["waiting"]);
        if (parked.state !== "waiting") throw new Error("unreachable");
        expect(parked.reason).toBe("retry");
        await instance.tasks.sendEvent(runId, "item", { value: 3 });
        backdateTaskWake(state.storage, runId, "after-events");
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const completed = await waitForState(instance.tasks, runId, [
          "completed"
        ]);
        if (completed.state !== "completed") throw new Error("unreachable");
        expect(completed.result).toMatchObject([
          { payload: { value: 1 } },
          { payload: { value: 2 } }
        ]);
        expect(instance.stepRuns).toEqual([
          "eventReplay:after-events",
          "eventReplay:after-events"
        ]);
        const available = state.storage.sql
          .exec(
            "SELECT payload FROM cf_agents_task_events WHERE run_id = ? AND consumed_at IS NULL",
            runId
          )
          .toArray();
        expect(available).toEqual([{ payload: '{"value":3}' }]);
      }
    );
  });

  it("deduplicates events and rejects conflicts or invalid targets", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      await expect(
        instance.tasks.sendEvent("missing", "item", { value: 1 })
      ).rejects.toMatchObject({ name: "TaskRunNotFoundError" });

      const receipt = await instance.tasks.run("eventDrain");
      await waitForState(instance.tasks, receipt.runId, ["waiting"]);
      const first = await instance.tasks.sendEvent(
        receipt.runId,
        "item",
        { value: 1 },
        { idempotencyKey: "delivery:1" }
      );
      const duplicate = await instance.tasks.sendEvent(
        receipt.runId,
        "item",
        { value: 1 },
        { idempotencyKey: "delivery:1" }
      );
      expect(duplicate).toEqual({ ...first, accepted: false });
      await expect(
        instance.tasks.sendEvent(
          receipt.runId,
          "item",
          { value: 2 },
          { idempotencyKey: "delivery:1" }
        )
      ).rejects.toMatchObject({ name: "TaskEventIdempotencyConflictError" });

      await instance.tasks.cancel(receipt.runId);
      const terminalDuplicate = await instance.tasks.sendEvent(
        receipt.runId,
        "item",
        { value: 1 },
        { idempotencyKey: "delivery:1" }
      );
      expect(terminalDuplicate).toEqual({ ...first, accepted: false });
      await expect(
        instance.tasks.sendEvent(receipt.runId, "item", { value: 3 })
      ).rejects.toMatchObject({ name: "TaskRunTerminalError" });
    });
  });

  it("fails immediately on NonRetryableError and reports through onError", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("doomed");
      const snapshot = await waitForState(instance.tasks, receipt.runId, [
        "failed"
      ]);
      if (snapshot.state !== "failed") throw new Error("unreachable");
      expect(snapshot.error).toEqual({
        name: "NonRetryableError",
        message: "no retry"
      });
      // No retry attempts were made.
      expect(instance.stepRuns).toEqual(["doomed:boom"]);
      expect(instance.runErrors).toEqual(["no retry"]);
    });
  });

  it("suppresses replayed progress behind the live gate", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());

    const runId = await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        instance.failuresBeforeSuccess = 1;
        const receipt = await instance.tasks.run("gated");
        await waitForState(instance.tasks, receipt.runId, ["waiting"]);
        const [row] = state.storage.sql
          .exec(
            "SELECT status_message FROM cf_agents_task_runs WHERE run_id = ?",
            receipt.runId
          )
          .toArray();
        expect(row?.status_message).toBe("after:2");

        backdateTaskWake(state.storage, receipt.runId, "gate");
        await instance.lifecycle.rearmAlarm();
        return receipt.runId;
      }
    );

    await runDurableObjectAlarm(stub);

    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await waitForState(instance.tasks, runId, ["completed"]);
        // The replay re-ran the handler from the top (counter reached 4) but
        // its old-ground status calls were suppressed: the persisted message
        // still carries the first attempt's counter value.
        expect(instance.statusCounter).toBe(4);
        const [row] = state.storage.sql
          .exec(
            "SELECT status_message FROM cf_agents_task_runs WHERE run_id = ?",
            runId
          )
          .toArray();
        expect(row?.status_message).toBe("after:2");
        expect(instance.stepRuns).toEqual([
          "gated:work",
          "gated:gate:1",
          "gated:gate:2"
        ]);
      }
    );
  });

  it("cancels a parked run immediately", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("sleeper", { ms: 60_000 });
      await waitForState(instance.tasks, receipt.runId, ["waiting"]);

      expect(
        await instance.tasks.cancel(receipt.runId, "changed my mind")
      ).toBe(true);
      const snapshot = await instance.tasks.get(receipt.runId);
      expect(snapshot?.state).toBe("cancelled");
      if (snapshot?.state !== "cancelled") throw new Error("unreachable");
      expect(snapshot.reason).toBe("changed my mind");

      // A settled run cannot be cancelled again.
      expect(await instance.tasks.cancel(receipt.runId)).toBe(false);
      expect(instance.stepRuns).not.toContain("sleeper:after");
    });
  });

  it("cancels a live attempt cooperatively through its abort signal", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("blocked");
      await waitFor(() => instance.stepRuns.includes("blocked:hang"));

      expect(await instance.tasks.cancel(receipt.runId, "stop it")).toBe(true);
      const snapshot = await waitForState(instance.tasks, receipt.runId, [
        "cancelled"
      ]);
      if (snapshot.state !== "cancelled") throw new Error("unreachable");
      expect(snapshot.reason).toBe("stop it");
    });
  });

  it("times out a step that ignores its abort signal", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("slowpoke");
      const snapshot = await waitForState(instance.tasks, receipt.runId, [
        "failed"
      ]);
      if (snapshot.state !== "failed") throw new Error("unreachable");
      expect(snapshot.error.message).toMatch(/timed out after 40ms/);
    });
  });

  it("rejects duplicate step names before executing user code", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("clash");
      const snapshot = await waitForState(instance.tasks, receipt.runId, [
        "failed"
      ]);
      if (snapshot.state !== "failed") throw new Error("unreachable");
      expect(snapshot.error.name).toBe("DuplicateTaskStepError");
    });
  });

  it("fails visibly when replay diverges from the journal", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        // The journal says "first" was a sleep; the handler declares a do.
        seedTaskRun(state.storage, {
          runId: "diverged-run",
          definition: "pipeline",
          input: { label: "x" },
          state: "pending",
          nextAt: Date.now() - 1000
        });
        seedTaskStep(state.storage, {
          runId: "diverged-run",
          name: "first",
          kind: "sleep",
          state: "waiting",
          nextAt: Date.now() - 1000
        });
        await instance.lifecycle.rearmAlarm();
      }
    );

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const snapshot = await waitForState(instance.tasks, "diverged-run", [
        "failed"
      ]);
      if (snapshot.state !== "failed") throw new Error("unreachable");
      expect(snapshot.error.name).toBe("TaskReplayDivergedError");
      expect(instance.stepRuns).toEqual([]);
    });
  });

  it("fails a run whose definition is no longer registered", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        seedTaskRun(state.storage, {
          runId: "ghost-run",
          definition: "ghost",
          state: "pending",
          nextAt: Date.now() - 1000
        });
        await instance.lifecycle.rearmAlarm();
      }
    );

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const snapshot = await waitForState(instance.tasks, "ghost-run", [
        "failed"
      ]);
      if (snapshot.state !== "failed") throw new Error("unreachable");
      expect(snapshot.error.name).toBe("MissingTaskDefinitionError");
      expect(snapshot.error.message).toContain('"ghost"');
    });
  });

  it("coexists with the Scheduler on the shared alarm", async () => {
    const stub = env.TaskSchedulerCoexistObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskSchedulerCoexistObject, state) => {
        const schedule = await instance.scheduler.set(120, "remind", "tick");
        expect(await state.storage.getAlarm()).toBe(schedule.time * 1000);

        // A sooner task deadline wins the shared alarm.
        const receipt = await instance.tasks.run("sleeper", { ms: 60_000 });
        const parked = await waitForState(instance.tasks, receipt.runId, [
          "waiting"
        ]);
        if (parked.state !== "waiting") throw new Error("unreachable");
        expect(parked.wakeAt).toBeLessThan(schedule.time * 1000);
        await waitFor(
          async () => (await state.storage.getAlarm()) === parked.wakeAt
        );

        // Settling every task run hands the alarm back to the Scheduler —
        // it is re-armed, not deleted.
        await instance.tasks.cancel(receipt.runId);
        expect(await state.storage.getAlarm()).toBe(schedule.time * 1000);
      }
    );
  });

  it("a stalled attempt detaches at the dispatch budget instead of starving the queue", async () => {
    const stub = env.TaskSchedulerCoexistObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskSchedulerCoexistObject, state) => {
        await instance.lifecycle.start();
        // Seed directly so the QUEUE wake drives the run — the public run()
        // starts a warm attempt outside the dispatch loop.
        seedTaskRun(state.storage, {
          runId: "stall-1",
          definition: "stall",
          state: "pending",
          nextAt: Date.now() - 1_000
        });
        await instance.scheduler.set(0, "remind", "tick");
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);

    await runInDurableObject(
      stub,
      async (instance: TaskSchedulerCoexistObject) => {
        // The stalled step was claimed, then execution detached at the
        // dispatch budget — so the schedule behind it fired within seconds,
        // not after the five-minute default step timeout.
        await waitFor(() => instance.remindRuns.includes("tick"), 15_000);
        expect(instance.stepRuns).toContain("stall:hang");
        await instance.tasks.cancel("stall-1");
      }
    );
  });

  it("defers an exhausted platform step to a fresh alarm invocation", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    const result = await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.__DO_NOT_USE_WILL_BREAK__enqueue(
          "exhaustedPlatformStep",
          undefined
        );
        backdateTaskWake(state.storage, receipt.runId);
        await instance.lifecycle.rearmAlarm();

        let threw = false;
        try {
          await (instance as unknown as { alarm(): Promise<void> }).alarm();
        } catch (error) {
          threw =
            error instanceof Error &&
            error.message.includes("Network connection lost");
        }

        return {
          threw,
          run: await instance.tasks.get(receipt.runId),
          stepRuns: instance.stepRuns.slice()
        };
      }
    );

    expect(result.threw).toBe(true);
    expect(result.stepRuns).toEqual(["exhausted-platform-step:1"]);
    expect(result.run?.state).toBe("running");
  });

  it("a platform-class failure never settles the run; replay completes it", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    let runId = "";
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      instance.platformFailuresRemaining = 1;
      const receipt = await instance.tasks.run("platformFlaky");
      runId = receipt.runId;
      await waitFor(() => instance.platformFailuresRemaining === 0);
      // The warm attempt hit a platform-shaped reset AFTER journaling its
      // step: the run must remain claimed — not failed — with the claim
      // backstop as its durable wake, and onError must not observe it.
      const after = await instance.tasks.get(receipt.runId);
      expect(after?.state).toBe("running");
      expect(instance.runErrors).toEqual([]);
    });

    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        backdateTaskWake(state.storage, runId);
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const snapshot = await waitForState(instance.tasks, runId, ["completed"]);
      if (snapshot.state !== "completed") throw new Error("unreachable");
      expect(snapshot.result).toBe("seed-done");
      // The journaled step did not re-execute on replay.
      expect(instance.stepRuns).toEqual(["platform:seed"]);
    });
  });

  it("removes non-retained records after completion", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run(
        "pipeline",
        { label: "gone" },
        { retain: false }
      );
      const deadline = Date.now() + 5_000;
      for (;;) {
        const snapshot = await instance.tasks.get(receipt.runId);
        if (snapshot === null) break;
        expect(snapshot.state).not.toBe("failed");
        if (Date.now() > deadline) {
          throw new Error("non-retained run was not removed");
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(instance.stepRuns).toEqual(["pipeline:first", "pipeline:second"]);
    });
  });

  it("removes consumed and buffered events for a non-retained run", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run(
          "eventWaiter",
          { type: "approval" },
          { retain: false }
        );
        await waitForState(instance.tasks, receipt.runId, ["waiting"]);
        await instance.tasks.sendEvent(receipt.runId, "other", {
          value: "buffered"
        });
        await instance.tasks.sendEvent(receipt.runId, "approval", {
          value: "consumed"
        });
        await waitFor(
          async () => (await instance.tasks.get(receipt.runId)) === null
        );

        expect(
          state.storage.sql
            .exec(
              "SELECT event_id FROM cf_agents_task_events WHERE run_id = ?",
              receipt.runId
            )
            .toArray()
        ).toEqual([]);
      }
    );
  });

  it("removes non-retained records after cancellation", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run(
        "sleeper",
        { ms: 60_000 },
        { retain: false }
      );
      await waitForState(instance.tasks, receipt.runId, ["waiting"]);
      expect(
        await instance.tasks.cancel(receipt.runId, "no longer needed")
      ).toBe(true);
      await waitFor(
        async () => (await instance.tasks.get(receipt.runId)) === null
      );
    });
  });

  it("deletes retained terminal runs on request", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("pipeline", { label: "keep" });
      await waitForState(instance.tasks, receipt.runId, ["completed"]);

      expect(await instance.tasks.delete({ status: ["failed"] })).toBe(0);
      expect(await instance.tasks.delete()).toBe(1);
      expect(await instance.tasks.get(receipt.runId)).toBeNull();
    });
  });

  it("deletes consumed and buffered events with a retained run", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run("eventWaiter", {
          type: "approval"
        });
        await waitForState(instance.tasks, receipt.runId, ["waiting"]);
        await instance.tasks.sendEvent(receipt.runId, "other", {
          value: "buffered"
        });
        await instance.tasks.sendEvent(receipt.runId, "approval", {
          value: "consumed"
        });
        await waitForState(instance.tasks, receipt.runId, ["completed"]);
        expect(
          state.storage.sql
            .exec(
              `SELECT type, consumed_at IS NOT NULL AS consumed
                 FROM cf_agents_task_events
                WHERE run_id = ?
                ORDER BY sequence`,
              receipt.runId
            )
            .toArray()
        ).toEqual([
          { type: "other", consumed: 0 },
          { type: "approval", consumed: 1 }
        ]);

        expect(await instance.tasks.delete()).toBe(1);
        expect(
          state.storage.sql
            .exec(
              "SELECT event_id FROM cf_agents_task_events WHERE run_id = ?",
              receipt.runId
            )
            .toArray()
        ).toEqual([]);
      }
    );
  });

  it("rejects oversized inputs at acceptance", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      await expect(
        instance.tasks.run("pipeline", { label: "x".repeat(1_100_000) })
      ).rejects.toThrow(/exceeds the 1048576-byte limit/);
      expect(await instance.tasks.list()).toEqual([]);
    });
  });

  it("rejects names outside the declared definitions map", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      // Unknown names are a compile error on the typed map; erase the typing
      // to exercise the runtime rejection. The double cast is required: the
      // conditional output type in handle() makes the Handlers generic
      // invariant, so a typed map does not widen to the default surface.
      const untyped = instance.tasks as unknown as Tasks;
      await expect(untyped.run("nope")).rejects.toThrow(
        'Unknown Task definition "nope"'
      );
      expect(() => untyped.handle("nope")).toThrow(
        'Unknown Task definition "nope"'
      );
      await expect(untyped.run("__cf_internal_x")).rejects.toThrow(/reserved/);
      await expect(untyped.run("")).rejects.toThrow(/non-empty/);

      // A handle is a pure lens over the declared map, so it can be created
      // at any time — including after Lifecycle startup.
      await instance.lifecycle.start();
      expect(instance.tasks.handle("pipeline").name).toBe("pipeline");
    });
  });

  it("replays after unclean interruption, resuming from the journal", async () => {
    const name = crypto.randomUUID();
    const stub = env.TaskHarnessObject.getByName(name);
    const capture = captureTaskEvents(name);

    try {
      await runInDurableObject(
        stub,
        async (instance: TaskHarnessObject, state) => {
          await instance.lifecycle.start();
          seedTaskRun(state.storage, {
            runId: "guarded-run",
            definition: "guarded",
            input: { label: "ctx" },
            state: "running",
            generation: "dead-generation",
            attempt: 1,
            nextAt: Date.now() - 1000
          });
          seedTaskStep(state.storage, {
            runId: "guarded-run",
            name: "g-first",
            kind: "do",
            state: "completed",
            result: "g:JOURNAL"
          });
          seedTaskStep(state.storage, {
            runId: "guarded-run",
            name: "g-second",
            kind: "do",
            state: "running",
            attempt: 1
          });
          await instance.lifecycle.rearmAlarm();
        }
      );

      await runDurableObjectAlarm(stub);

      await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
        const snapshot = await waitForState(instance.tasks, "guarded-run", [
          "completed"
        ]);
        if (snapshot.state !== "completed") throw new Error("unreachable");
        // Replay from the top: the journaled first step short-circuited and
        // only the interrupted second step re-executed.
        expect(snapshot.result).toBe("run-done:g:JOURNAL");
        expect(instance.stepRuns).toEqual(["guarded:second"]);
        // The handler observed durable evidence of the interruption at
        // entry: the step the lost attempt left mid-execution.
        expect(instance.guardedEntries).toEqual(["entry:ctx:g-second"]);
      });
      const types = capture.events.map((event) => event.type);
      expect(types).toContain("task:attempt:interrupted");
    } finally {
      capture.stop();
    }
  });

  it("clean step failures retry without looking like interruptions", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    const runId = await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject) => {
        instance.failuresBeforeSuccess = 1;
        const receipt = await instance.tasks.run("guarded", { label: "r" });
        const parked = await waitForState(instance.tasks, receipt.runId, [
          "waiting"
        ]);
        if (parked.state !== "waiting") throw new Error("unreachable");
        expect(parked.reason).toBe("retry");
        return receipt.runId;
      }
    );

    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        backdateTaskWake(state.storage, runId, "g-second");
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const snapshot = await waitForState(instance.tasks, runId, ["completed"]);
      if (snapshot.state !== "completed") throw new Error("unreachable");
      expect(snapshot.result).toBe("run-done:g:r");
      // Both handler entries saw a clean journal — a retry park is not an
      // interruption, so no step was ever left mid-execution at entry.
      expect(instance.guardedEntries).toEqual(["entry:r:none", "entry:r:none"]);
    });
  });
});
