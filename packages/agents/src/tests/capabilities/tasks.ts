import { DurableObject } from "cloudflare:workers";
import { getCurrentAgent, Lifecycle } from "../../lifecycle";
import {
  Tasks,
  NonRetryableError,
  TaskInterruptionsExhaustedError,
  defineAsk,
  type TaskDefinition,
  type TaskMachine,
  type TaskStep
} from "../../tasks";

/** The ask kind the `approver` machine raises; answers are strings. */
export const Approval = defineAsk<{ what: string }, string>("approval");
import { setTaskDefinitionResolver } from "../../tasks/tasks";
import { Scheduler } from "../../schedules";
import { Streams } from "../../streams";

/** The one phase the harness's machine definition declares. */
type CounterState = { phase: "counting"; value: number };
type StuckState = { phase: "idle" };
type SpinnerState = { phase: "spin"; n: number };
type BudgetedState =
  | { phase: "ping"; n: number }
  | { phase: "pong"; n: number };
type NapperState = { phase: "nap"; ms: number } | { phase: "done" };
type GuardState =
  | { phase: "hold"; decline: boolean; releases: number }
  | { phase: "released"; decline: boolean; releases: number };
type HungState = { phase: "hang" };
type MemoState = { phase: "work"; rounds: number };
type ParentState =
  | { phase: "spawn"; background: boolean }
  | { phase: "join"; children: string[] };
type GuardianState =
  | { phase: "spawn"; background: boolean }
  | { phase: "wait"; child: string };
type StreamerState = { phase: "first" } | { phase: "second" };
type RefundState = { phase: "work" };
type WardenState = { phase: "spawn" } | { phase: "wait"; child: string };
type NapStreamerState = { phase: "stream" };
type InboxState = {
  phase: "listen";
  seen: string[];
  within: number | undefined;
};
type ApproverState =
  | { phase: "ask"; expiresIn: number | undefined }
  | { phase: "wait"; pending: { id: string }[]; mode: "all" | "any" };
export type VersionedState =
  | { phase: "one"; n: number }
  | { phase: "two"; n: number; migrated: boolean };

/**
 * Version 1 of a versioned machine, supplied through the harness's dynamic
 * resolver so a test can "redeploy" by swapping it for a version 2.
 */
export const versionedV1 = {
  initial: { phase: "one", n: 1 } as VersionedState,
  phases: {
    one: async (state, ctx) => {
      await ctx.sleep("wait", 60_000);
      return ctx.complete(state.n);
    },
    two: async (state, ctx) => ctx.complete(state.n)
  }
} satisfies TaskMachine<VersionedState, never, number>;

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
  /** External deduplication keys step callbacks were handed. */
  readonly stepKeys: string[] = [];
  /** Terminal run errors observed through the capability's onError. */
  readonly runErrors: string[] = [];
  /** The run each onError observation named, with the error's name. */
  readonly runErrorRuns: Array<{
    runId: string;
    definition: string;
    name: string;
  }> = [];
  /** Interruption counts carried by observed exhaustion failures. */
  readonly runErrorInterruptions: number[] = [];
  /** Handler bodies that entered an await on `step.signal`, by input label. */
  readonly signalWaits: string[] = [];
  /** Abort reasons `step.signal` delivered to handler bodies. */
  readonly signalReasons: string[] = [];
  /** Failures injected into flaky step callbacks before they succeed. */
  failuresBeforeSuccess = 0;
  /** Platform-shaped failures injected at handler level before success. */
  platformFailuresRemaining = 0;
  /** Monotonic counter proving handlers re-ran from the top on replay. */
  statusCounter = 0;
  /**
   * Guarded handler entries, recorded as
   * `entry:input:interrupted-step:a<run attempt>`.
   */
  readonly guardedEntries: string[] = [];
  /** `onCancel` entries, recorded as `phase:mark`. */
  readonly cancelLog: string[] = [];
  /** Compensations that ran, in the order they ran. */
  readonly compensations: string[] = [];
  /** Definitions resolved lazily, so a test can swap versions in place. */
  readonly dynamic: Record<string, TaskDefinition> = {
    "versioned@v1": versionedV1
  };

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    setTaskDefinitionResolver(
      this.tasks,
      (name) => this.dynamic[name],
      () => Object.keys(this.dynamic)
    );
  }

  /** Engine-owned streams are written through this sibling capability. */
  readonly streams = new Streams();

  readonly tasks = new Tasks({
    streams: this.streams,
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

      /**
       * Awaits outside any step until the attempt-wide `step.signal` aborts,
       * then unwinds with its reason — the shape of a long model turn or a
       * drain loop held in the handler body.
       */
      awaitsSignal: async (input: { label: string }, step: TaskStep) => {
        this.signalWaits.push(input.label);
        await new Promise<never>((_resolve, reject) => {
          const fail = () => {
            const reason: unknown = step.signal.reason;
            this.signalReasons.push(
              reason instanceof Error
                ? reason.name
                : ((reason as { constructor?: { name?: string } })?.constructor
                    ?.name ?? String(reason))
            );
            reject(reason);
          };
          if (step.signal.aborted) return fail();
          step.signal.addEventListener("abort", fail, { once: true });
        });
      },

      /**
       * Catches the attempt-wide abort, cleans up, and returns a result — a
       * handler that honours cancellation cooperatively. The run must still
       * settle cancelled, never completed with this result.
       */
      swallowsCancel: async (input: { label: string }, step: TaskStep) => {
        this.signalWaits.push(input.label);
        try {
          await new Promise<never>((_resolve, reject) => {
            const fail = () => reject(step.signal.reason);
            if (step.signal.aborted) return fail();
            step.signal.addEventListener("abort", fail, { once: true });
          });
        } catch {
          return { stopped: true };
        }
      },

      /**
       * Notices the cancel, then lingers before returning: the window
       * `cancel({ wait })` has to close, and that a bare `cancel()` leaves
       * open.
       */
      lingersAfterCancel: async (input: { label: string }, step: TaskStep) => {
        this.signalWaits.push(input.label);
        try {
          await new Promise<never>((_resolve, reject) => {
            const fail = () => reject(step.signal.reason);
            if (step.signal.aborted) return fail();
            step.signal.addEventListener("abort", fail, { once: true });
          });
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 250));
          return { stopped: true };
        }
      },

      /** Holds the handler body forever and ignores `step.signal`. */
      deaf: async (input: { label: string }, _step: TaskStep) => {
        this.signalWaits.push(input.label);
        await new Promise<never>(() => {});
      },

      /** Ignores its signal; the engine's timeout race must still win. */
      slowpoke: async (_input: undefined, step: TaskStep) => {
        await step.do(
          "slow",
          { timeout: 40, retries: { limit: 1 } },
          () => new Promise<never>(() => {})
        );
      },

      /** Asks for an impossible step retry budget; the config is validated. */
      badStepPolicy: async (_input: undefined, step: TaskStep) => {
        await step.do("nope", { retries: { limit: 0 } }, () => "unreachable");
      },

      /** Uses the same step name twice in one replay. */
      clash: async (_input: undefined, step: TaskStep) => {
        await step.do("same", () => 1);
        await step.do("same", () => 2);
      },

      /**
       * Observes replay after unclean interruption: a reclaimed run
       * re-executes from the top, journaled steps short-circuit, and the
       * handler records each entry so tests can prove replay semantics.
       */
      guarded: async (input: { label: string }, step: TaskStep) => {
        this.guardedEntries.push(
          `entry:${input.label}:${step.interrupted?.name ?? "none"}:a${step.attempt}`
        );
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

      /**
       * Two steps in flight at once. The fast one fails cleanly and parks
       * the run on its step retry while the slow one is still `running` in
       * the journal — a step row left mid-execution with no isolate lost,
       * which the replay must not mistake for interruption evidence.
       */
      concurrent: async (input: { label: string }, step: TaskStep) => {
        this.guardedEntries.push(
          `entry:${input.label}:${step.interrupted?.name ?? "none"}:a${step.attempt}`
        );
        await Promise.all([
          step.do("c-slow", async () => {
            this.stepRuns.push("concurrent:slow");
            await new Promise((resolve) => setTimeout(resolve, 200));
            return "slow";
          }),
          step.do(
            "c-fast",
            { retries: { limit: 2, delay: "1 minute" } },
            () => {
              this.stepRuns.push("concurrent:fast");
              if (this.failuresBeforeSuccess > 0) {
                this.failuresBeforeSuccess -= 1;
                throw new Error("fast failed cleanly");
              }
              return "fast";
            }
          )
        ]);
        return `concurrent-done:${input.label}`;
      },

      /**
       * Throws a platform-shaped error at handler level (outside any step)
       * while injected failures remain; replays complete normally.
       */
      platformFlaky: async (_input: undefined, step: TaskStep) => {
        const seed = await step.do("seed", () => {
          this.stepRuns.push("platform:seed");
          return "seed";
        });
        if (this.platformFailuresRemaining > 0) {
          this.platformFailuresRemaining -= 1;
          throw new Error("Durable Object reset because its code was updated.");
        }
        return `${seed}-done`;
      },

      /**
       * Records the external deduplication key one step is handed, which is
       * what pins the key's exact bytes across a schema migration.
       */
      keyed: async (_input: undefined, step: TaskStep) => {
        return step.do("keyed-step", ({ idempotencyKey }) => {
          this.stepRuns.push("keyed:keyed-step");
          this.stepKeys.push(idempotencyKey);
          return idempotencyKey;
        });
      },

      /** A single journaled step, for replay-memoization assertions. */
      checkpointing: async (_input: undefined, step: TaskStep) => {
        await step.do("mark", () => {
          this.stepRuns.push("checkpointing:mark");
          return "ok";
        });
        return "fin";
      },

      /**
       * Deterministically exhausts memory while a durable countdown remains
       * (#1825): the counter survives the breaker's isolate resets, so every
       * reclaim re-throws until the countdown ends — the shape of a doomed
       * recovery loop the alarm memory-limit breaker must contain.
       */
      oomLoop: async (_input: undefined, _step: TaskStep) => {
        const remaining =
          (await this.ctx.storage.get<number>("oomLoopRemaining")) ?? 0;
        if (remaining > 0) {
          await this.ctx.storage.put("oomLoopRemaining", remaining - 1);
          await this.ctx.storage.sync();
          throw new Error(
            "Durable Object's isolate exceeded its memory limit and was reset."
          );
        }
        return "recovered";
      },

      /** The same poison signal thrown from inside a journaled step. */
      oomStepLoop: async (_input: undefined, step: TaskStep) => {
        await step.do(
          "oom-step",
          { retries: { limit: 3, delay: "1 minute" } },
          async () => {
            const remaining =
              (await this.ctx.storage.get<number>("oomLoopRemaining")) ?? 0;
            if (remaining > 0) {
              await this.ctx.storage.put("oomLoopRemaining", remaining - 1);
              await this.ctx.storage.sync();
              throw new Error(
                "Durable Object's isolate exceeded its memory limit and was reset."
              );
            }
            return "recovered";
          }
        );
      },

      /** Exhausts its durable step budget on a platform transient. */
      exhaustedPlatformStep: async (_input: undefined, step: TaskStep) => {
        await step.do(
          "connection",
          { retries: { limit: 1 } },
          ({ attempt }) => {
            this.stepRuns.push(`exhausted-platform-step:${attempt}`);
            throw new Error("Network connection lost.");
          }
        );
      },

      /** Throws the OOM signal only after Tasks detaches from JobDriver. */
      lateOomStepLoop: async (_input: undefined, step: TaskStep) => {
        await step.do(
          "late-oom-step",
          { retries: { limit: 3 }, timeout: 10_000 },
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 5_050));
            const remaining =
              (await this.ctx.storage.get<number>("oomLoopRemaining")) ?? 0;
            if (remaining > 0) {
              await this.ctx.storage.put("oomLoopRemaining", remaining - 1);
              await this.ctx.storage.sync();
              throw new Error(
                "Durable Object's isolate exceeded its memory limit and was reset."
              );
            }
            return "recovered";
          }
        );
      },

      /**
       * One condemned attempt observed by two handoffs: the step's own memory
       * reset plus a sibling promise the handler registered with the alarm
       * that rejects with the same reset. The breaker must record one strike
       * for the pair, not one per observer.
       */
      twinLateOom: async (_input: undefined, step: TaskStep) => {
        const sibling = new Promise<never>((_resolve, reject) => {
          setTimeout(
            () =>
              reject(
                new Error(
                  "Durable Object's isolate exceeded its memory limit and was reset."
                )
              ),
            5_050
          );
        });
        this.lifecycle.trackAlarmWork(sibling);
        await step.do(
          "twin-oom-step",
          { retries: { limit: 3 }, timeout: 10_000 },
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 5_050));
            const remaining =
              (await this.ctx.storage.get<number>("oomLoopRemaining")) ?? 0;
            if (remaining > 0) {
              await this.ctx.storage.put("oomLoopRemaining", remaining - 1);
              await this.ctx.storage.sync();
              throw new Error(
                "Durable Object's isolate exceeded its memory limit and was reset."
              );
            }
            return "recovered";
          }
        );
      },

      /**
       * This run's own attempt strikes distinctly BEFORE a separately
       * tracked sibling settles clean. The strike's isolate-reset side
       * effect is scheduled but deferred; the clean sibling settling in that
       * gap must not clear what the strike just recorded.
       */
      oomBeforeCleanSibling: async (_input: undefined, step: TaskStep) => {
        const cleanSibling = new Promise<string>((resolve) => {
          setTimeout(() => resolve("clean-sibling"), 7_000);
        });
        this.lifecycle.trackAlarmWork(cleanSibling);
        await step.do(
          "oom-before-clean-sibling",
          { retries: { limit: 3 }, timeout: 10_000 },
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 5_050));
            const remaining =
              (await this.ctx.storage.get<number>("oomLoopRemaining")) ?? 0;
            if (remaining > 0) {
              await this.ctx.storage.put("oomLoopRemaining", remaining - 1);
              await this.ctx.storage.sync();
              throw new Error(
                "Durable Object's isolate exceeded its memory limit and was reset."
              );
            }
            return "recovered";
          }
        );
      },

      /** Settles successfully after Tasks' five-second job handoff. */
      lateSuccess: async (_input: undefined, step: TaskStep) => {
        return step.do("late-success-step", { timeout: 10_000 }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 5_250));
          return "late-success";
        });
      },

      /**
       * Clean sibling that is still active when the same alarm starts an OOM.
       * Well under the 2s step timeout so it completes rather than re-parks.
       */
      alarmSiblingSuccess: async (_input: undefined, step: TaskStep) => {
        return step.do("alarm-sibling", async () => {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          return "alarm-sibling-success";
        });
      },

      /**
       * A machine definition, declared so the capability's machine-typed
       * members are reachable from a test at their real types and so the
       * stage's dispatch refusal is observable. Its phases do not run yet:
       * the machine dispatch loop lands with the engine.
       */
      counter: {
        initial: (seed: { from: number }): CounterState => ({
          phase: "counting",
          value: seed.from
        }),
        phases: {
          counting: async (state, ctx) =>
            state.value >= 3
              ? ctx.complete(state.value)
              : { phase: "counting", value: state.value + 1 }
        }
      } satisfies TaskMachine<
        CounterState,
        { step: number },
        number,
        { from: number }
      >,

      /** Rule A by construction: the same checkpoint, no park, no credit. */
      stuck: {
        initial: { phase: "idle" } as StuckState,
        phases: { idle: async (state) => state }
      } satisfies TaskMachine<StuckState>,

      /** Rule B by construction: every transition changes the checkpoint. */
      spinner: {
        initial: { phase: "spin", n: 0 } as SpinnerState,
        phases: {
          spin: async (state) => ({ phase: "spin", n: state.n + 1 })
        }
      } satisfies TaskMachine<SpinnerState>,

      /** Six transitions without a park, under its own tighter Rule B bound. */
      tightBudget: {
        initial: { phase: "ping", n: 0 } as BudgetedState,
        phases: {
          ping: async (state, ctx) =>
            state.n >= 6
              ? ctx.complete(state.n)
              : { phase: "pong", n: state.n + 1 },
          pong: async (state, ctx) =>
            state.n >= 6
              ? ctx.complete(state.n)
              : { phase: "ping", n: state.n + 1 }
        },
        transitionBudget: 3
      } satisfies TaskMachine<BudgetedState, never, number>,

      /** Parks on a sleep in its first phase, then completes. */
      napper: {
        initial: (seed: { ms: number }): NapperState => ({
          phase: "nap",
          ms: seed.ms
        }),
        phases: {
          nap: async (state, ctx) => {
            await ctx.sleep("rest", state.ms);
            return { phase: "done" };
          },
          done: async (_state, ctx) => ctx.complete("rested")
        }
      } satisfies TaskMachine<NapperState, never, string, { ms: number }>,

      /** Declares `onCancel`: unwinds to a terminal, or declines the cancel. */
      guardedMachine: {
        initial: (seed: { decline: boolean }): GuardState => ({
          phase: "hold",
          decline: seed.decline,
          releases: 0
        }),
        phases: {
          hold: async (state, ctx) => {
            await ctx.sleep("hold", 60_000);
            return { ...state, phase: "released" };
          },
          released: async (state, ctx) => ctx.complete(state.releases)
        },
        onCancel: async (state, ctx) => {
          this.cancelLog.push(`${state.phase}:${ctx.cancelling}`);
          if (state.decline) {
            return {
              phase: "released",
              decline: false,
              releases: state.releases + 1
            };
          }
          return ctx.aborted("unwound");
        }
      } satisfies TaskMachine<GuardState, never, number, { decline: boolean }>,

      /** A transition that never returns and never heartbeats. */
      hung: {
        initial: { phase: "hang" } as HungState,
        phases: { hang: () => new Promise<never>(() => {}) }
      } satisfies TaskMachine<HungState>,

      /**
       * Receives messages one at a time — buffered ones first — until a
       * "stop", then completes with everything it saw. A "boom" throws
       * after the receive. A `within` turns a silent mailbox into a
       * "timed-out" completion.
       */
      inbox: {
        initial: (seed: { within?: number }): InboxState => ({
          phase: "listen",
          seen: [],
          within: seed.within
        }),
        phases: {
          listen: async (state, ctx) => {
            const item = await ctx.receive({
              kind: "message",
              ...(state.within !== undefined ? { within: state.within } : {})
            });
            if (item === ctx.timedOut) return ctx.complete("timed-out");
            const text = String(item.payload);
            if (text === "stop") return ctx.complete(state.seen.join(","));
            // Receives, then throws: the probe for what a failed run does
            // with the message it had already consumed.
            if (text === "boom") throw new Error("inbox boom");
            return { ...state, seen: [...state.seen, text] };
          }
        }
      } satisfies TaskMachine<InboxState, string, string, { within?: number }>,

      /** Raises two asks, parks on their answers, completes with them. */
      approver: {
        initial: (seed: {
          expiresIn?: number;
          mode?: "all" | "any";
        }): ApproverState => ({ phase: "ask", expiresIn: seed.expiresIn }),
        phases: {
          ask: async (state, ctx) => {
            const pending = ctx.ask(
              Approval,
              [{ what: "first" }, { what: "second" }],
              state.expiresIn !== undefined
                ? { expiresIn: state.expiresIn }
                : undefined
            );
            return {
              phase: "wait",
              pending: pending.map((ask) => ({ id: ask.id })),
              mode: (ctx.input as { mode?: "all" | "any" }).mode ?? "all"
            };
          },
          wait: async (state, ctx) => {
            const answers = await ctx.answers(
              state.pending.map((ask) => ask as { id: string }),
              { mode: state.mode }
            );
            if (answers === ctx.timedOut) return ctx.complete("timed-out");
            return ctx.complete(
              answers.map((answer) => answer ?? "lapsed").join("+")
            );
          }
        }
      } satisfies TaskMachine<
        ApproverState,
        never,
        string,
        { expiresIn?: number; mode?: "all" | "any" }
      >,

      /** A durable function that waits for one approval event. */
      listener: async (
        input: { timeout?: number },
        step: TaskStep
      ): Promise<string> => {
        const event = await step.waitForEvent<{ ok: boolean }>("go", {
          type: "approval",
          ...(input.timeout !== undefined ? { timeout: input.timeout } : {})
        });
        return `${event.type}:${event.payload.ok}:${event.timestamp instanceof Date}`;
      },

      /** Spawns two children, joins them, completes with their outputs. */
      parent: {
        initial: (seed: { background?: boolean }): ParentState => ({
          phase: "spawn",
          background: seed.background === true
        }),
        phases: {
          spawn: async (state, ctx) => {
            const first = await ctx.spawn(
              "pipeline",
              { label: "kid" },
              { runId: `${ctx.id}:kid-1` }
            );
            const second = await ctx.spawn(
              "counter",
              { from: 1 },
              {
                runId: `${ctx.id}:kid-2`,
                background: state.background,
                ...(state.background ? { notify: true } : {})
              }
            );
            return { phase: "join", children: [first.runId, second.runId] };
          },
          join: async (state, ctx) => {
            const results = await ctx.join(state.children, { within: 60_000 });
            if (results === ctx.timedOut) return ctx.complete("timed-out");
            return ctx.complete(
              results
                .map((result) =>
                  result.ok
                    ? JSON.stringify(result.output)
                    : `error:${result.error.name}`
                )
                .join("|")
            );
          }
        }
      } satisfies TaskMachine<
        ParentState,
        never,
        string,
        { background?: boolean }
      >,

      /** Spawns one long-parked child and waits on it: the cascade probe. */
      guardian: {
        initial: (seed: { background: boolean }): GuardianState => ({
          phase: "spawn",
          background: seed.background
        }),
        phases: {
          spawn: async (state, ctx) => {
            const child = await ctx.spawn(
              "napper",
              { ms: 60_000 },
              { runId: `${ctx.id}:ward`, background: state.background }
            );
            return { phase: "wait", child: child.runId };
          },
          wait: async (state, ctx) => {
            const results = await ctx.join([state.child]);
            if (results === ctx.timedOut) return ctx.complete("timed-out");
            return ctx.complete(results[0]?.ok ? "child-done" : "child-failed");
          }
        }
      } satisfies TaskMachine<
        GuardianState,
        never,
        string,
        { background: boolean }
      >,

      /** Spawns a child that declares onCancel and waits on it. */
      guardianOfGuarded: {
        initial: { phase: "spawn" } as WardenState,
        phases: {
          spawn: async (_state, ctx) => {
            const child = await ctx.spawn(
              "guardedMachine",
              { decline: false },
              { runId: `${ctx.id}:ward` }
            );
            return { phase: "wait", child: child.runId };
          },
          wait: async (state, ctx) => {
            const results = await ctx.join([state.child]);
            if (results === ctx.timedOut) return ctx.complete("timed-out");
            return ctx.complete(results[0]?.ok ? "child-done" : "child-failed");
          }
        }
      } satisfies TaskMachine<WardenState, never, string>,

      /** Spawns a child without choosing its id, and waits on it. */
      spawnerDefault: {
        initial: { phase: "spawn" } as WardenState,
        phases: {
          spawn: async (_state, ctx) => {
            const child = await ctx.spawn("napper", { ms: 60_000 });
            return { phase: "wait", child: child.runId };
          },
          wait: async (state, ctx) => {
            const results = await ctx.join([state.child]);
            if (results === ctx.timedOut) return ctx.complete("timed-out");
            return ctx.complete(results[0]?.ok ? "child-done" : "child-failed");
          }
        }
      } satisfies TaskMachine<WardenState, never, string>,

      /** Spawns a child that faults, and joins it. */
      parentOfStuck: {
        initial: { phase: "spawn" } as WardenState,
        phases: {
          spawn: async (_state, ctx) => {
            const child = await ctx.spawn("stuck", undefined, {
              runId: `${ctx.id}:stuck`
            });
            return { phase: "wait", child: child.runId };
          },
          wait: async (state, ctx) => {
            const results = await ctx.join([state.child]);
            if (results === ctx.timedOut) return ctx.complete("timed-out");
            const [result] = results;
            return ctx.complete(
              result?.ok ? "child-done" : `error:${result?.error.name}`
            );
          }
        }
      } satisfies TaskMachine<WardenState, never, string>,

      /** Spawns a `retain: false` child and joins it: the note outlives it. */
      releaser: {
        initial: { phase: "spawn" } as WardenState,
        phases: {
          spawn: async (_state, ctx) => {
            const child = await ctx.spawn(
              "counter",
              { from: 1 },
              { runId: `${ctx.id}:released`, retain: false }
            );
            return { phase: "wait", child: child.runId };
          },
          wait: async (state, ctx) => {
            const results = await ctx.join([state.child]);
            if (results === ctx.timedOut) return ctx.complete("timed-out");
            const [result] = results;
            return ctx.complete(
              result?.ok ? JSON.stringify(result.output) : "child-failed"
            );
          }
        }
      } satisfies TaskMachine<WardenState, never, string>,

      /** Streams across two phases: the first stream settles with the commit. */
      streamer: {
        initial: { phase: "first" } as StreamerState,
        phases: {
          first: async (_state, ctx) => {
            const writer = await ctx.stream();
            writer.append("a");
            writer.append("b");
            return { phase: "second" };
          },
          second: async (_state, ctx) => {
            const writer = await ctx.stream();
            writer.append("c");
            return ctx.complete(writer.streamId);
          }
        }
      } satisfies TaskMachine<StreamerState, never, string>,

      /** Streams, then parks on a sleep with the stream still live. */
      napStreamer: {
        initial: { phase: "stream" } as NapStreamerState,
        phases: {
          stream: async (_state, ctx) => {
            const writer = await ctx.stream("out");
            writer.append("x");
            writer.append("y");
            await ctx.sleep("nap", 60_000);
            return ctx.complete(writer.streamId);
          }
        }
      } satisfies TaskMachine<NapStreamerState, never, string>,

      /** Closes its own stream, then returns a terminal on the same turn. */
      closingStreamer: {
        initial: { phase: "stream" } as NapStreamerState,
        phases: {
          stream: async (_state, ctx) => {
            const writer = await ctx.stream("out");
            writer.append("x");
            writer.close();
            return ctx.complete(writer.streamId);
          }
        }
      } satisfies TaskMachine<NapStreamerState, never, string>,

      /** Streams, then returns a terminal result that cannot serialize. */
      cyclicStreamer: {
        initial: { phase: "stream" } as NapStreamerState,
        phases: {
          stream: async (_state, ctx) => {
            const writer = await ctx.stream("out");
            writer.append("x");
            const cyclic: { self?: unknown } = {};
            cyclic.self = cyclic;
            return ctx.complete(cyclic as unknown as string);
          }
        }
      } satisfies TaskMachine<NapStreamerState, never, string>,

      /**
       * Two compensable effects, then a long park: the cancel probe.
       * `hang` awaits the attempt signal outside any step; `failRefund`
       * makes the newer compensation throw; `slowRefund` makes it hang
       * past its step's timeout.
       */
      refundable: async (
        input: { hang?: boolean; failRefund?: boolean; slowRefund?: boolean },
        step: TaskStep
      ) => {
        await step.do(
          "reserve",
          { compensate: () => void this.compensations.push("release") },
          () => "held"
        );
        const charge = await step.do(
          "charge",
          {
            timeout: 100,
            compensate: async (result) => {
              if (input.failRefund === true) throw new Error("refund failed");
              if (input.slowRefund === true) await new Promise(() => {});
              this.compensations.push(`refund:${result}`);
            }
          },
          () => 42
        );
        if (input.hang === true) {
          // Awaits outside a step: only the attempt signal ends this.
          await new Promise<void>((_resolve, reject) => {
            step.signal.addEventListener("abort", () =>
              reject(step.signal.reason)
            );
          });
        }
        await step.sleep("settle", 60_000);
        return charge;
      },

      /** The same effects on a machine without onCancel. */
      refundableMachine: {
        initial: { phase: "work" } as RefundState,
        phases: {
          work: async (_state, ctx) => {
            await ctx.do(
              "reserve",
              { compensate: () => void this.compensations.push("release") },
              () => "held"
            );
            await ctx.do(
              "charge",
              {
                compensate: (result) =>
                  void this.compensations.push(`refund:${result}`)
              },
              () => 42
            );
            await ctx.sleep("settle", 60_000);
            return ctx.complete("charged");
          }
        }
      } satisfies TaskMachine<RefundState, never, string>,

      /** Progress without a checkpoint change: a memo, then completion. */
      memoist: {
        initial: { phase: "work", rounds: 0 } as MemoState,
        phases: {
          work: async (state, ctx) =>
            ctx.complete(ctx.memo("token", `t-${state.rounds}`))
        }
      } satisfies TaskMachine<MemoState, never, string>
    },
    retries: { limit: 3, delay: 5, backoff: "constant" },
    stepTimeout: 2_000,
    onError: (error, run) => {
      this.runErrors.push(
        error instanceof Error ? error.message : String(error)
      );
      this.runErrorRuns.push({
        runId: run.runId,
        definition: run.definition,
        name: error instanceof Error ? error.name : String(error)
      });
      if (error instanceof TaskInterruptionsExhaustedError) {
        this.runErrorInterruptions.push(error.interruptions);
      }
    }
  });

  readonly lifecycle = Lifecycle.install(this)
    .use(this.streams)
    .use(this.tasks);
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
  /** Payloads the `remind` schedule callback observed. */
  readonly remindRuns: string[] = [];

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
      },

      /** Hangs until aborted; proves a stuck attempt cannot starve the queue. */
      stall: async (_input: undefined, step: TaskStep) => {
        await step.do("hang", ({ signal }) => {
          this.stepRuns.push("stall:hang");
          return new Promise<never>((_resolve, reject) => {
            const fail = () => reject(signal.reason ?? new Error("aborted"));
            if (signal.aborted) return fail();
            signal.addEventListener("abort", fail, { once: true });
          });
        });
      }
    }
  });

  readonly scheduler = new Scheduler({
    callbacks: {
      remind: (payload) => {
        this.remindRuns.push(String(payload));
      },

      /**
       * Sleeps, then conditionally throws the OOM signal. A Scheduler job
       * carries none of Tasks' own active-attempt tracking, so a memory-limit
       * regression test can use it to isolate JobDriver's own alarm-boundary
       * attribution from Tasks' independent (and already correct) re-tracking
       * of a Task run an overlapping alarm invocation happens to re-dispatch.
       */
      slowOom: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const remaining =
          (await this.ctx.storage.get<number>("oomLoopRemaining")) ?? 0;
        if (remaining > 0) {
          await this.ctx.storage.put("oomLoopRemaining", remaining - 1);
          await this.ctx.storage.sync();
          throw new Error(
            "Durable Object's isolate exceeded its memory limit and was reset."
          );
        }
      }
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
    readonly retain?: boolean;
    readonly idempotencyKey?: string;
    readonly deadlineAt?: number;
    readonly interruptions?: number;
    readonly retryPolicy?: {
      readonly limit: number;
      readonly delayMs: number;
      readonly backoff: "constant" | "linear" | "exponential";
    };
    /** The run that owns this one, for delete-cascade and child tests. */
    readonly parentRunId?: string;
  }
): void {
  const now = Date.now();
  storage.sql.exec(
    `INSERT INTO cf_agents_task_runs
       (run_id, definition, input, state, generation, attempt, next_at,
        idempotency_key, retain, deadline_at, interruptions, retry_policy,
        parent_run_id, cancel_requested, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    options.runId,
    options.definition,
    options.input === undefined ? null : JSON.stringify(options.input),
    options.state,
    options.generation ?? null,
    options.attempt ?? 0,
    options.nextAt,
    options.idempotencyKey ?? null,
    options.retain === false ? 0 : 1,
    options.deadlineAt ?? null,
    options.interruptions ?? 0,
    // Stored exactly as acceptance resolves it: the capability reads the
    // policy back from this column, never from the run options.
    options.retryPolicy === undefined
      ? null
      : JSON.stringify({
          retryLimit: options.retryPolicy.limit,
          retryDelayMs: options.retryPolicy.delayMs,
          backoff: options.retryPolicy.backoff
        }),
    options.parentRunId ?? null,
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

/** Insert one journal row directly, bypassing the engine. */
export function seedTaskJournal(
  storage: DurableObjectStorage,
  options: {
    readonly runId: string;
    /** The run's committed checkpoint turn; 0 for a function definition. */
    readonly turn: number;
    readonly name: string;
    readonly kind: "do" | "sleep" | "event";
    readonly state: "running" | "waiting" | "completed";
    readonly result?: unknown;
    readonly attempt?: number;
    readonly nextAt?: number;
  }
): void {
  const now = Date.now();
  storage.sql.exec(
    `INSERT INTO cf_agents_task_journal
       (run_id, turn, name, kind, state, result, attempt, next_at,
        created_at, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    options.runId,
    options.turn,
    options.name,
    options.kind,
    options.state,
    options.result === undefined ? null : JSON.stringify(options.result),
    options.attempt ?? (options.state === "waiting" ? 1 : 0),
    options.nextAt ?? null,
    now,
    now,
    now
  );
}

/** Insert one mailbox row directly, bypassing the engine. */
export function seedTaskMailbox(
  storage: DurableObjectStorage,
  options: {
    readonly runId: string;
    readonly key: string;
    readonly kind: string;
    readonly seq?: number;
    readonly type?: string;
    readonly payload?: unknown;
  }
): void {
  const now = Date.now();
  storage.sql.exec(
    `INSERT INTO cf_agents_task_mailbox
       (run_id, key, seq, kind, type, payload, visible_after, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    options.runId,
    options.key,
    options.seq ?? 0,
    options.kind,
    options.type ?? null,
    options.payload === undefined ? null : JSON.stringify(options.payload),
    now
  );
}

/** Insert one ask row directly, bypassing the engine. */
export function seedTaskAsk(
  storage: DurableObjectStorage,
  options: {
    readonly askId: string;
    readonly runId: string;
    readonly name: string;
    readonly turn?: number;
    readonly state?: "open" | "answered" | "expired" | "withdrawn";
    readonly question?: unknown;
  }
): void {
  const now = Date.now();
  storage.sql.exec(
    `INSERT INTO cf_agents_task_asks
       (ask_id, run_id, turn, name, question, answer, state, expires_at,
        metadata, created_at, answered_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, NULL)`,
    options.askId,
    options.runId,
    options.turn ?? 0,
    options.name,
    options.question === undefined ? null : JSON.stringify(options.question),
    options.state ?? "open",
    now
  );
}

/**
 * Put one accepted run into the shape an unclean interruption leaves: still
 * `running` under a generation whose isolate is gone, and due now. Runs
 * accepted through the public API reach the reclaim path this way, policy
 * and all, without a test hand-writing the row.
 */
export function interruptTaskRun(
  storage: DurableObjectStorage,
  runId: string,
  options: { readonly generation?: string | null } = {}
): void {
  const past = Date.now() - 1000;
  storage.sql.exec(
    `UPDATE cf_agents_task_runs
     SET state = 'running', generation = ?, wait_reason = NULL, next_at = ?,
         updated_at = ?
     WHERE run_id = ?`,
    options.generation === undefined ? "dead-generation" : options.generation,
    past,
    Date.now(),
    runId
  );
  storage.sql.exec(
    "UPDATE cf_agents_jobs SET time = ? WHERE id = ? AND capability = 'tasks'",
    past,
    `task:${runId}`
  );
}

/** Backdate a parked run (and optionally one step) so the alarm sees it due. */
export function backdateTaskWake(
  storage: DurableObjectStorage,
  runId: string,
  stepName?: string,
  turn = 0
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
    `task:${runId}`
  );
  if (stepName !== undefined) {
    storage.sql.exec(
      `UPDATE cf_agents_task_journal SET next_at = ?
       WHERE run_id = ? AND turn = ? AND name = ?`,
      past,
      runId,
      turn,
      stepName
    );
  }
}
