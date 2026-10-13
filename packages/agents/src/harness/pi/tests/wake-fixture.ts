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
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const registry = createRegistry();
      registry.install({ name: "test-tasks", tasks: [SleepUntil] });
      return Harness.open(
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
    },
    defaults: { model: this.#faux.getModel() }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    setWakeTimingForTests(this.harness, TEST_TIMING);
    this.#faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "503 service unavailable"
      }),
      fauxAssistantMessage([fauxText("recovered")])
    ]);
  }

  /** Create a background task in the root session that is due at `runAt`. */
  async sleepUntil(runAt: number): Promise<TaskId> {
    const pi = await this.harness.pi();
    const root = await pi.root(BACKGROUND_CONTEXT);
    return root.commit(
      (tx) =>
        tx.createTask(
          SleepUntil,
          { runAt },
          { ownership: { kind: "conversation" }, background: true }
        ),
      BACKGROUND_CONTEXT
    );
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
