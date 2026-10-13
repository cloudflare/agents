import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineTask,
  Harness,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type TaskId
} from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../../lifecycle";
import { setWakeTimingForTests } from "../harness";
import { BACKGROUND_CONTEXT } from "../context";
import { PiHarness } from "../index";
import { fauxModels } from "./faux";
import { TEST_TIMING } from "./timing";

/** Long enough that a wake parked on it would miss everything else. */
export const GENERATION_RETRY_DELAY_MS = 60_000;

/** Short enough that a test sees a wake's wait run out. */
export const WAIT_BUDGET_MS = 300;

/** Storage key of an error a session's idle wait rejects with, if set. */
const IDLE_ERROR_KEY = "test:idle-error";

/** A background task that sleeps until `runAt`, then completes. */
const SleepUntil = defineTask<{ runAt: number }, { phase: "wait" }, null>({
  name: "test.sleep-until",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: async (task, runtime, context) => {
      await runtime.sleep(task.input.runAt, context);
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "completed", result: null }
        }),
        context
      );
    }
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      context
    );
  }
});

/**
 * A harness whose first model request fails with a retryable error and
 * waits `GENERATION_RETRY_DELAY_MS` before retrying, so a generation can
 * sit in a long retry while other work in the session is due sooner.
 */
export class PiWakeTestObject extends DurableObject<Cloudflare.Env> {
  readonly #faux = fauxProvider({
    tokensPerSecond: 200,
    tokenSize: { min: 2, max: 4 }
  });
  #failInspect = false;
  #inspectFailures = 0;
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const registry = createRegistry();
      registry.install({ name: "test-tasks", tasks: [SleepUntil] });
      const pi = await Harness.open(
        storage,
        {
          models: fauxModels(this.#faux.provider),
          registry,
          settings: {
            retry: {
              enabled: true,
              maxRetries: 1,
              baseDelayMs: GENERATION_RETRY_DELAY_MS,
              maxAgentDelayMs: GENERATION_RETRY_DELAY_MS
            }
          }
        },
        context
      );
      // Switches the tests flip to make wake dispatches or idle waits fail.
      // The idle error is stored, so it holds across a crash.
      const conversation = pi.conversation.bind(pi);
      pi.conversation = async (...args) => {
        const found = await conversation(...args);
        if (found === undefined) return found;
        const waitForIdle = found.waitForIdle.bind(found);
        found.waitForIdle = async (...waitArgs) => {
          const error = await this.ctx.storage.get<string>(IDLE_ERROR_KEY);
          if (error !== undefined) throw new Error(error);
          return waitForIdle(...waitArgs);
        };
        return found;
      };
      const inspect = pi.inspect.bind(pi);
      pi.inspect = async (...args) => {
        if (this.#failInspect) {
          this.#inspectFailures++;
          throw new Error("inspect is unavailable");
        }
        return inspect(...args);
      };
      return pi;
    },
    defaults: { model: this.#faux.getModel() }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    setWakeTimingForTests(this.harness, {
      ...TEST_TIMING,
      waitBudgetMs: WAIT_BUDGET_MS
    });
    this.#faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "503 service unavailable"
      }),
      fauxAssistantMessage([fauxText("recovered")])
    ]);
  }

  /** Run startup, which gives every session with live work a wake job. */
  async start(): Promise<void> {
    await this.harness.pi();
  }

  /** Make every session's idle wait reject with `message`, or stop. */
  async failIdleWait(message: string | undefined): Promise<void> {
    if (message === undefined) await this.ctx.storage.delete(IDLE_ERROR_KEY);
    else await this.ctx.storage.put(IDLE_ERROR_KEY, message);
  }

  /** The alarm memory-limit breaker's strike count. */
  async memoryLimitStrikes(): Promise<number> {
    return (
      (await this.ctx.storage.get<number>("cf_agents:oom_alarm_strikes")) ?? 0
    );
  }

  /** Create a task in the root session that is due at `runAt`. */
  async sleepUntil(
    runAt: number,
    options: { background?: boolean } = {}
  ): Promise<TaskId> {
    const pi = await this.harness.pi();
    const root = await pi.root(BACKGROUND_CONTEXT);
    return root.commit(
      (tx) =>
        tx.createTask(
          SleepUntil,
          { runAt },
          {
            ownership: { kind: "conversation" },
            background: options.background ?? true
          }
        ),
      BACKGROUND_CONTEXT
    );
  }

  /** Fail or restore pi's `inspect()`, once pi is open. */
  async failInspect(fail: boolean): Promise<void> {
    await this.harness.pi();
    this.#failInspect = fail;
  }

  inspectFailures(): number {
    return this.#inspectFailures;
  }

  async submit(text: string) {
    return this.harness.submit(text);
  }

  /** When the root's generation will retry, once it is backing off. */
  async retryAt(): Promise<number | undefined> {
    const pi = await this.harness.pi();
    const live = await pi.snapshot(
      LiveDoc,
      ROOT_CONVERSATION_ID,
      BACKGROUND_CONTEXT
    );
    return live?.generation?.retry?.at;
  }

  /** The due time of a session's wake job, or null without one. */
  async wakeJobTime(session = "1"): Promise<number | null> {
    const rows = this.ctx.storage.sql
      .exec<{
        time: number;
      }>("SELECT time FROM cf_agents_jobs WHERE id = ?", `pi-wake:${session}`)
      .toArray();
    return rows[0]?.time ?? null;
  }
}
