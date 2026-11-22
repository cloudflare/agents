/**
 * Messenger replies as runs on the Tasks capability. A live webhook reply
 * executes as one journaled step through the messenger runtime's closure
 * registry, persisting its re-entry snapshot in host storage; a replay whose
 * closure is gone is recovered on wake through
 * `ThinkMessengerRuntime.handleFiberRecovery`.
 *
 * Durable: the Task run and the reply's recovery snapshot (one storage key
 * per run, deleted when the step ends). In memory: the live reply closure.
 */

import {
  isDurableObjectCodeUpdateReset,
  isDurableObjectMemoryLimitReset,
  isPlatformTransientError,
  type FiberRecoveryContext
} from "agents";
import type { Tasks } from "agents/tasks";
import type { TaskJson } from "agents/tasks";
import type { ThinkMessengerRuntime } from "./chat-sdk";
import { MESSENGER_REPLY_FIBER_NAME } from "./delivery";

/**
 * Definition name for messenger reply runs on the Tasks capability. The
 * reserved prefix keeps it outside the public `fibers.run()` surface; the
 * recovery context still carries the historical `MESSENGER_REPLY_FIBER_NAME`
 * so the messenger runtime's recovery gate is unchanged.
 */
const MESSENGER_REPLY_TASK_DEFINITION = "__cf_internal_messenger_reply";

const runIdFor = (nonce: string) => `msgr_${nonce}`;

/** Register the messenger-reply Task definition on `tasks`. */
export function registerMessengerReplyTask(
  tasks: Tasks,
  options: {
    runtime: () => ThinkMessengerRuntime | undefined;
    storage: DurableObjectStorage;
  }
): void {
  const { storage } = options;
  tasks.register(MESSENGER_REPLY_TASK_DEFINITION, async (input, step) => {
    const { nonce } = input as { nonce: string };
    await step.do(
      "deliver",
      { retries: { limit: 1 }, timeout: "1 day" },
      async ({ signal }) => {
        const runtime = options.runtime();
        if (!runtime) {
          throw new Error("Messenger runtime is unavailable");
        }
        const runId = runIdFor(nonce);
        const persistKey = `__cf_messenger_recovery:${runId}`;
        if (!runtime.hasLiveReply(nonce)) {
          // Replay after an unclean interruption: recover through the
          // runtime seam, preferring the snapshot a prior attempt (live
          // or recovering) persisted before being interrupted itself.
          const persisted = await storage.get(persistKey);
          const createdAt = (await tasks.get(runId))?.createdAt ?? Date.now();
          const ctx: FiberRecoveryContext = {
            id: runId,
            name: MESSENGER_REPLY_FIBER_NAME,
            snapshot: (persisted ?? null) as unknown,
            createdAt,
            recoveryReason: "interrupted"
          };
          await runtime.handleFiberRecovery(ctx, {
            persistRecoverySnapshot: async (snapshot) => {
              await storage.put(persistKey, snapshot);
            },
            // Platform failures leave the step claimed and the run is
            // replayed; any other error fails this single-attempt step.
            retriesAfter: (error) =>
              isPlatformTransientError(error) ||
              isDurableObjectMemoryLimitReset(error) ||
              isDurableObjectCodeUpdateReset(error)
          });
          await storage.delete(persistKey);
          return undefined;
        }
        // The initial "accepted" snapshot must be durable before any
        // delivery work begins: an isolate lost mid-answer recovers
        // through this snapshot, and without it replay could neither
        // deliver nor apologize.
        const initial = runtime.initialReplySnapshot(nonce);
        if (initial !== undefined) {
          await storage.put(persistKey, initial);
        }
        // Later fire-and-forget stash writes are safe: Durable Object
        // storage applies same-key operations in issuance order, so the
        // delete below can never be overtaken by an earlier put. A crash
        // loses only the unflushed tail, which recovery tolerates by
        // design (the snapshot is a hint; stream evidence is
        // authoritative).
        await runtime.executeLiveReply(nonce, {
          id: runId,
          signal,
          stash: (data) => void storage.put(persistKey, data).catch(() => {}),
          snapshot: null
        });
        await storage.delete(persistKey);
        return undefined;
      }
    );
  });
}

/**
 * Durably accept one reply run and execute it inline while this isolate
 * lives. `accepted` is false when the idempotency key already has a run.
 */
export async function runMessengerReplyTask(
  tasks: Tasks,
  input: {
    nonce: string;
    idempotencyKey: string;
    metadata: Record<string, unknown>;
  }
): Promise<{ accepted: boolean }> {
  const receipt = await tasks.__DO_NOT_USE_WILL_BREAK__runAttached(
    MESSENGER_REPLY_TASK_DEFINITION,
    { nonce: input.nonce },
    {
      runId: runIdFor(input.nonce),
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata as Record<string, TaskJson>
    }
  );
  return { accepted: receipt.accepted };
}
