import { DurableObject } from "cloudflare:workers";
import { getCurrentAgent, Lifecycle } from "../../lifecycle";
import {
  Tasks,
  NonRetryableError,
  type TaskInterruption,
  type TaskStep
} from "../../tasks";
import { Scheduler } from "../../schedules";

/**
 * Minimal real host for capability-level Tasks tests: a Durable Object
 * whose ONLY capability is Tasks, installed through a real Lifecycle and
 * driven by real storage and real platform alarms — proving the capability
 * stands alone. Coexistence with other capabilities on the shared alarm is
 * proven separately by {@link TaskSchedulerCoexistObject}. This is the
 * platform-dispatch half of the capability testing pattern (see
 * `capability-harness.ts` for the isolation half).
 *
 * Instance counters record which step callbacks actually executed, so tests
 * can distinguish real execution from journal hits during replay.
 */
export class TaskHarnessObject extends DurableObject<Cloudflare.Env> {
  /** Step callbacks that actually ran (journal hits never append here). */
  readonly stepRuns: string[] = [];
  /** Terminal run errors observed through the capability's onError. */
  readonly runErrors: string[] = [];
  /** Failures injected into flaky step callbacks before they succeed. */
  failuresBeforeSuccess = 0;
  /** Monotonic counter proving handlers re-ran from the top on replay. */
  statusCounter = 0;
  /** Recovery invocations, recorded as definition:input:step:checkpoint. */
  readonly recoveryCalls: string[] = [];
  /** What the guarded definition's recover callback decides. */
  recoveryMode:
    | "complete"
    | "replay"
    | "replay-later"
    | "fail"
    | "cancel"
    | "explode" = "complete";

  readonly tasks = new Tasks({
    definitions: {
      /** Two journaled steps, then a host-context probe in the return value. */
      pipeline: async (input: { label: string }, step: TaskStep) => {
        const first = await step.do("first", () => {
          this.stepRuns.push("pipeline:first");
          return `first:${input.label}`;
        });
        const second = await step.do("second", () => {
          this.stepRuns.push("pipeline:second");
          return `second:${first}`;
        });
        return {
          first,
          second,
          hadHostContext: getCurrentAgent<TaskHarnessObject>().agent === this
        };
      },

      /** A stable step, then one failing `failuresBeforeSuccess` times. */
      flaky: async (input: { label: string }, step: TaskStep) => {
        const seed = await step.do("seed", () => {
          this.stepRuns.push("flaky:seed");
          return `${input.label}-seed`;
        });
        // The long retry delay keeps the parked run observable: imminent
        // alarms auto-fire in workerd, so tests backdate the wake instead.
        return step.do(
          "unstable",
          { retries: { limit: 3, delay: "1 minute", backoff: "constant" } },
          ({ attempt }) => {
            this.stepRuns.push(`flaky:unstable:${attempt}`);
            if (this.failuresBeforeSuccess > 0) {
              this.failuresBeforeSuccess -= 1;
              throw new Error("unstable failure");
            }
            return `${seed}-ok`;
          }
        );
      },

      /** Durable sleep between two journaled steps. */
      sleeper: async (input: { ms: number }, step: TaskStep) => {
        await step.do("before", () => {
          this.stepRuns.push("sleeper:before");
          return "before";
        });
        await step.sleep("nap", input.ms);
        await step.do("after", () => {
          this.stepRuns.push("sleeper:after");
          return "after";
        });
        return "done";
      },

      /** Fails immediately without retries. */
      doomed: async (_input: undefined, step: TaskStep) => {
        await step.do("boom", () => {
          this.stepRuns.push("doomed:boom");
          throw new NonRetryableError("no retry");
        });
      },

      /**
       * Status calls around a flaky gate. The counter values expose whether
       * a replay re-published old progress: with the live gate working, the
       * persisted message keeps the first attempt's counter value.
       */
      gated: async (_input: undefined, step: TaskStep) => {
        await step.status(`start:${++this.statusCounter}`);
        await step.do("work", () => {
          this.stepRuns.push("gated:work");
          return "worked";
        });
        await step.status(`after:${++this.statusCounter}`);
        await step.do(
          "gate",
          { retries: { limit: 2, delay: "1 minute" } },
          ({ attempt }) => {
            this.stepRuns.push(`gated:gate:${attempt}`);
            if (this.failuresBeforeSuccess > 0) {
              this.failuresBeforeSuccess -= 1;
              throw new Error("gate failed");
            }
            return "opened";
          }
        );
        return "done";
      },

      /** Hangs until its abort signal fires; used for cancellation tests. */
      blocked: async (_input: undefined, step: TaskStep) => {
        await step.do("hang", ({ signal }) => {
          this.stepRuns.push("blocked:hang");
          return new Promise<never>((_resolve, reject) => {
            const fail = () => reject(signal.reason ?? new Error("aborted"));
            if (signal.aborted) return fail();
            signal.addEventListener("abort", fail, { once: true });
          });
        });
      },

      /** Ignores its signal; the engine's timeout race must still win. */
      slowpoke: async (_input: undefined, step: TaskStep) => {
        await step.do(
          "slow",
          { timeout: 40, retries: { limit: 1 } },
          () => new Promise<never>(() => {})
        );
      },

      /** Uses the same step name twice in one replay. */
      clash: async (_input: undefined, step: TaskStep) => {
        await step.do("same", () => 1);
        await step.do("same", () => 2);
      },

      /**
       * A definition with a recovery callback: unclean interruption invokes
       * `recover` (behavior selected by `recoveryMode`) instead of replaying;
       * clean step failures follow the ordinary retry policy.
       */
      guarded: {
        run: async (input: { label: string }, step: TaskStep) => {
          const first = await step.do("g-first", () => {
            this.stepRuns.push("guarded:first");
            return `g:${input.label}`;
          });
          await step.do(
            "g-second",
            { retries: { limit: 2, delay: "1 minute" } },
            () => {
              this.stepRuns.push("guarded:second");
              if (this.failuresBeforeSuccess > 0) {
                this.failuresBeforeSuccess -= 1;
                throw new Error("second failed cleanly");
              }
              return "s";
            }
          );
          return `run-done:${first}`;
        },
        recover: async (interruption: TaskInterruption<{ label: string }>) => {
          this.recoveryCalls.push(
            `${interruption.definition}:${interruption.input.label}:` +
              `${interruption.interruptedStep?.name ?? "none"}:` +
              `${JSON.stringify(interruption.interruptedStep?.checkpoint ?? null)}`
          );
          switch (this.recoveryMode) {
            case "complete":
              return { action: "complete" as const, result: "recovered" };
            case "replay":
              return { action: "replay" as const };
            case "replay-later":
              return { action: "replay" as const, at: Date.now() + 60_000 };
            case "fail":
              return {
                action: "fail" as const,
                error: new Error("recover says fail")
              };
            case "cancel":
              return {
                action: "cancel" as const,
                reason: "recover says cancel"
              };
            case "explode":
              throw new Error("recover exploded");
          }
        }
      },

      /** Writes a step checkpoint for later recovery inspection. */
      checkpointing: async (_input: undefined, step: TaskStep) => {
        await step.do("mark", ({ checkpoint }) => {
          checkpoint({ phase: "submitted" });
          this.stepRuns.push("checkpointing:mark");
          return "ok";
        });
        return "fin";
      }
    },
    retries: { limit: 3, delay: 5, backoff: "constant" },
    stepTimeout: 2_000,
    onError: (error) => {
      this.runErrors.push(
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.tasks);
}

/**
 * Tasks and the Scheduler installed together on one Lifecycle: proves two
 * independent capabilities arbitrate the single physical Durable Object
 * alarm correctly — the sooner deadline wins, and settling one capability's
 * work re-arms for the other instead of deleting its wake-up.
 */
export class TaskSchedulerCoexistObject extends DurableObject<Cloudflare.Env> {
  /** Step callbacks that actually ran. */
  readonly stepRuns: string[] = [];

  readonly tasks = new Tasks({
    definitions: {
      sleeper: async (input: { ms: number }, step: TaskStep) => {
        await step.do("before", () => {
          this.stepRuns.push("sleeper:before");
          return "before";
        });
        await step.sleep("nap", input.ms);
        await step.do("after", () => {
          this.stepRuns.push("sleeper:after");
          return "after";
        });
        return "done";
      }
    }
  });

  readonly scheduler = new Scheduler({
    callbacks: {
      remind: () => {}
    }
  });

  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.scheduler);
}

/** Insert one task run row directly, bypassing acceptance. */
export function seedTaskRun(
  storage: DurableObjectStorage,
  options: {
    readonly runId: string;
    readonly definition: string;
    readonly input?: unknown;
    readonly state: "pending" | "running" | "waiting";
    readonly generation?: string;
    readonly attempt?: number;
    readonly nextAt: number;
  }
): void {
  const now = Date.now();
  storage.sql.exec(
    `INSERT INTO cf_agents_task_runs
       (run_id, definition, input, state, generation, attempt, next_at,
        retain, cancel_requested, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    options.runId,
    options.definition,
    options.input === undefined ? null : JSON.stringify(options.input),
    options.state,
    options.generation ?? null,
    options.attempt ?? 0,
    options.nextAt,
    now,
    now
  );
  // Mirror the deadline as the run's Lifecycle queue job, exactly as the
  // capability does on acceptance — the physical alarm derives from the
  // queue, so a seeded run without its mirror job would never wake. The
  // queue table is created lazily by Lifecycle, so ensure it first.
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
      running INTEGER NOT NULL DEFAULT 0,
      execution_started_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`
  );
  storage.sql.exec(
    `INSERT OR REPLACE INTO cf_agents_jobs (id, capability, fn, time)
     VALUES (?, 'tasks', 'wake', ?)`,
    options.runId,
    options.nextAt
  );
}

/** Insert one task step row directly, bypassing the engine. */
export function seedTaskStep(
  storage: DurableObjectStorage,
  options: {
    readonly runId: string;
    readonly name: string;
    readonly kind: "do" | "sleep";
    readonly state: "running" | "waiting" | "completed";
    readonly result?: unknown;
    readonly attempt?: number;
    readonly nextAt?: number;
    readonly checkpoint?: unknown;
  }
): void {
  const now = Date.now();
  storage.sql.exec(
    `INSERT INTO cf_agents_task_steps
       (run_id, step_name, kind, state, result, attempt, checkpoint, next_at,
        created_at, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    options.runId,
    options.name,
    options.kind,
    options.state,
    options.result === undefined ? null : JSON.stringify(options.result),
    options.attempt ?? (options.state === "waiting" ? 1 : 0),
    options.checkpoint === undefined
      ? null
      : JSON.stringify(options.checkpoint),
    options.nextAt ?? null,
    now,
    now,
    now
  );
}

/** Backdate a parked run (and optionally one step) so the alarm sees it due. */
export function backdateTaskWake(
  storage: DurableObjectStorage,
  runId: string,
  stepName?: string
): void {
  const past = Date.now() - 1000;
  storage.sql.exec(
    "UPDATE cf_agents_task_runs SET next_at = ? WHERE run_id = ?",
    past,
    runId
  );
  storage.sql.exec(
    "UPDATE cf_agents_jobs SET time = ? WHERE id = ? AND capability = 'tasks'",
    past,
    runId
  );
  if (stepName !== undefined) {
    storage.sql.exec(
      "UPDATE cf_agents_task_steps SET next_at = ? WHERE run_id = ? AND step_name = ?",
      past,
      runId,
      stepName
    );
  }
}
