import { DurableObject } from "cloudflare:workers";
import { getCurrentAgent, Lifecycle } from "../../lifecycle";
import {
  Outbox,
  type OutboxDelivery,
  type OutboxDeliveryContext
} from "../../outbox";

/** One acknowledged or attempted delivery seen by a harness sink. */
export type OutboxAttempt = {
  readonly sink: string;
  readonly key: string;
  readonly payload: unknown;
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly checkpoint: unknown;
  readonly hadHostContext: boolean;
};

/**
 * Minimal real host for capability-level Outbox tests: a Durable Object
 * whose only capability is the Outbox. Deliveries run from the real
 * platform alarm. `hold()` parks every sink until `release()`; set
 * `failures` to fail the next attempts.
 */
export class OutboxHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly attempts: OutboxAttempt[] = [];
  readonly gaveUp: Array<{ key: string; payload: unknown; error: string }> = [];
  /** Attempts still to fail, per sink. */
  failures = 0;
  /** Posts made by the `steps` sink, in order. */
  readonly posts: string[] = [];
  #gate: Promise<void> | null = null;
  #release: (() => void) | null = null;
  #entered: (() => void) | null = null;

  readonly outbox = new Outbox({
    sinks: {
      record: {
        deliver: async (payload: { value: string }, delivery) => {
          await this.#enter(delivery, "record", payload);
          if (this.failures > 0) {
            this.failures -= 1;
            throw new Error("sink down");
          }
        },
        onGiveUp: (payload, delivery, error) => {
          this.gaveUp.push({
            key: delivery.key,
            payload,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      },
      fragile: {
        deliver: async (payload: string, delivery) => {
          await this.#enter(delivery, "fragile", payload);
          throw new Error("always down");
        },
        retry: { maxAttempts: 2 },
        onGiveUp: (payload, delivery: OutboxDelivery<string>, error) => {
          this.gaveUp.push({
            key: delivery.key,
            payload,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      },
      // Takes the object down before any I/O of its own.
      abort: {
        deliver: () => {
          this.ctx.abort("sink takes the object down");
        },
        retry: { maxAttempts: 2, attemptTimeoutMs: 200 }
      },
      steps: {
        // Delivers each part in order; a failure resumes after the last
        // part it posted.
        deliver: async (parts: string[], delivery) => {
          await this.#enter(delivery, "steps", parts);
          let next =
            typeof delivery.checkpoint === "number" ? delivery.checkpoint : 0;
          for (; next < parts.length; next++) {
            if (this.failures > 0 && next > 0) {
              this.failures -= 1;
              throw new Error("post failed");
            }
            this.posts.push(parts[next]);
            await delivery.saveCheckpoint(next + 1);
          }
        }
      }
    },
    retry: { baseDelayMs: 5, maxDelayMs: 20 }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.outbox);

  /** Park every sink until {@link release}; resolves once one is parked. */
  hold(): Promise<void> {
    this.#gate ??= new Promise((resolve) => {
      this.#release = resolve;
    });
    return new Promise((resolve) => {
      this.#entered = resolve;
    });
  }

  release(): void {
    this.#release?.();
    this.#gate = null;
    this.#release = null;
  }

  /** Raw rows, for tests that fabricate an interrupted attempt. */
  sql(query: string, ...params: (string | number | null)[]): unknown[] {
    return [...this.ctx.storage.sql.exec(query, ...params)];
  }

  async #enter(
    delivery: OutboxDeliveryContext,
    sink: string,
    payload: unknown
  ): Promise<void> {
    this.attempts.push({
      sink,
      key: delivery.key,
      payload,
      attempt: delivery.attempt,
      idempotencyKey: delivery.idempotencyKey,
      checkpoint: delivery.checkpoint,
      hadHostContext: getCurrentAgent<OutboxHarnessObject>().agent === this
    });
    this.#entered?.();
    this.#entered = null;
    await this.#gate;
  }
}

/** Poll until `done()` holds or the timeout elapses. */
export async function waitFor(
  done: () => boolean | Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met in time");
}
