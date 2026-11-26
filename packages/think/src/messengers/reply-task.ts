/**
 * Messenger replies as runs on the Tasks capability. A live webhook reply
 * runs as one journaled step with its closure as the run's `local`, and
 * keeps its re-entry snapshot in the run's checkpoint. A replay after a
 * reset has no closure, and is recovered from that snapshot through
 * `ThinkMessengerRuntime.handleFiberRecovery`.
 *
 * Durable: nothing of its own (the run and its checkpoint belong to Tasks).
 * In memory: the live closure, for as long as the webhook waits on it.
 */

import {
  isDurableObjectCodeUpdateReset,
  isDurableObjectMemoryLimitReset,
  isPlatformTransientError,
  type FiberContext,
  type FiberRecoveryContext
} from "agents";
import type { TaskJson, Tasks } from "agents/tasks";
import type { ThinkMessengerRuntime } from "./chat-sdk";
import { MESSENGER_REPLY_FIBER_NAME } from "./delivery";

/**
 * Definition name for messenger reply runs on the Tasks capability. The
 * reserved prefix keeps it outside the public `fibers.run()` surface; the
 * recovery context still carries the historical `MESSENGER_REPLY_FIBER_NAME`
 * so the messenger runtime's recovery gate is unchanged.
 */
const MESSENGER_REPLY_TASK_DEFINITION = "__cf_internal_messenger_reply";

/** The checkpoint key of a reply's re-entry snapshot. */
const SNAPSHOT = "snapshot";

/**
 * One reply the webhook that received its message is waiting on.
 *
 * @internal
 */
export type LiveMessengerReply = {
  /** The "accepted" snapshot, kept before any delivery work begins. */
  snapshot: unknown;
  answer(fiber: FiberContext): Promise<void>;
};

/**
 * The input to start one reply run.
 *
 * @internal
 */
export type MessengerReplyRun = {
  reply: LiveMessengerReply;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
};

/**
 * Register the reply definition on `tasks` (once per Durable Object
 * construction, as Tasks requires) and return the function that durably
 * accepts one reply run and executes it inline. `accepted` is false when
 * the idempotency key already has a run.
 *
 * @internal
 */
export function registerMessengerReplies(
  tasks: Tasks,
  runtime: () => ThinkMessengerRuntime | undefined
): (run: MessengerReplyRun) => Promise<{ accepted: boolean }> {
  tasks.register(MESSENGER_REPLY_TASK_DEFINITION, (_input, step) =>
    step.do(
      "deliver",
      { retries: { limit: 1 }, timeout: "1 day" },
      async ({ signal }) => {
        const messengers = runtime();
        if (!messengers) {
          throw new Error("Messenger runtime is unavailable");
        }
        const live = step.local as LiveMessengerReply | undefined;
        if (!live) {
          // Replay after an unclean interruption: recover through the
          // runtime seam from the snapshot a prior attempt (live or
          // recovering) kept before being interrupted itself.
          const ctx: FiberRecoveryContext = {
            id: step.id,
            name: MESSENGER_REPLY_FIBER_NAME,
            snapshot: step.checkpoint.get(SNAPSHOT) ?? null,
            createdAt: (await tasks.get(step.id))?.createdAt ?? Date.now(),
            recoveryReason: "interrupted"
          };
          await messengers.handleFiberRecovery(ctx, {
            persistRecoverySnapshot: (snapshot) => {
              step.checkpoint.set(SNAPSHOT, snapshot as unknown as TaskJson);
            },
            // Platform failures leave the step claimed and the run is
            // replayed; any other error fails this single-attempt step.
            retriesAfter: (error) =>
              isPlatformTransientError(error) ||
              isDurableObjectMemoryLimitReset(error) ||
              isDurableObjectCodeUpdateReset(error)
          });
          return undefined;
        }
        // The "accepted" snapshot is in the run's row before any delivery
        // work begins: an isolate lost mid-answer recovers through it, and
        // without it replay could neither deliver nor apologize.
        step.checkpoint.set(SNAPSHOT, live.snapshot as TaskJson);
        await live.answer({
          id: step.id,
          signal,
          stash: (data) => step.checkpoint.set(SNAPSHOT, data as TaskJson),
          snapshot: null
        });
        return undefined;
      }
    )
  );
  return async ({ reply, idempotencyKey, metadata }) => {
    const receipt = await tasks.run(
      MESSENGER_REPLY_TASK_DEFINITION,
      {},
      {
        idempotencyKey,
        metadata: metadata as Record<string, TaskJson>,
        start: "now",
        local: reply
      }
    );
    return { accepted: receipt.accepted };
  };
}
