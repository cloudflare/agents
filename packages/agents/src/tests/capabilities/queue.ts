import { DurableObject } from "cloudflare:workers";
import { getCurrentAgent, Lifecycle } from "../../lifecycle";
import { Queue, type QueueItem } from "../../queue";

/** One recorded queue-callback invocation on a harness object. */
export type QueueInvocation = {
  readonly callback: string;
  readonly payload: unknown;
  readonly itemId: string;
  readonly hadHostContext: boolean;
};

/**
 * Minimal real host for capability-level Queue tests: a Durable Object whose
 * only capability is the Queue, with runtime handlers installed so tests can
 * drive real Lifecycle startup, real storage, and real platform alarms.
 *
 * Pushed items are due immediately, so the platform alarm fires as soon as
 * the pushing invocation yields. Tests that need to read items back before
 * they run close the gate first; every callback then parks until `release()`.
 */
export class QueueHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly invocations: QueueInvocation[] = [];
  readonly callbackErrors: string[] = [];
  failuresBeforeSuccess = 0;
  #gate: Promise<void> | null = null;
  #release: (() => void) | null = null;

  readonly queue = new Queue({
    callbacks: {
      record: async (
        payload: { value: string },
        item: QueueItem<{ value: string }>
      ) => {
        await this.#gate;
        this.#record("record", payload, item);
      },
      flaky: async (payload: string, item: QueueItem<string>) => {
        await this.#gate;
        if (this.failuresBeforeSuccess > 0) {
          this.failuresBeforeSuccess -= 1;
          throw new Error("flaky failure");
        }
        this.#record("flaky", payload, item);
      },
      broken: async () => {
        await this.#gate;
        throw new Error("broken callback");
      }
    },
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    onError: (error) => {
      this.callbackErrors.push(
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.queue);

  /** Park every callback until {@link release}. */
  hold(): void {
    if (this.#gate) return;
    this.#gate = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  /** Let parked callbacks run. */
  release(): void {
    this.#release?.();
    this.#gate = null;
    this.#release = null;
  }

  #record(callback: string, payload: unknown, item: QueueItem<unknown>): void {
    this.invocations.push({
      callback,
      payload,
      itemId: item.id,
      hadHostContext: getCurrentAgent<QueueHarnessObject>().agent === this
    });
  }
}

/** Poll until the harness queue is empty or the timeout elapses. */
export async function waitForQueueDrain(
  instance: QueueHarnessObject,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await instance.queue.list()).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("queue did not drain in time");
}
