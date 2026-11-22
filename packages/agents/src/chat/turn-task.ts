/**
 * The chat-turn Task definition, shared by `AIChatAgent` and `Think`.
 *
 * Every chat turn runs as one journaled step on the `tasks` capability. A
 * live turn executes its closure (the run's `local`) under the fiber stash
 * context, so `this.stash()` writes the recovery snapshot into the run's
 * checkpoint; a replay whose closure is gone (the producing isolate died)
 * hands that snapshot to the host's chat recovery. Hosts supply their
 * protected internals through {@link ChatTurnTaskHooks}; the turn logic, the
 * snapshot key vocabulary, and the settle plumbing live here once.
 */

import type { TaskJson, TaskStep } from "../tasks";

/** One live turn closure: the `local` value of the turn's run in this isolate. */
export type ChatTurnClosureEntry = {
  /** The snapshot persisted at claim, before the turn produces anything. */
  readonly initial: unknown;
  /** Wrap user stash data into the durable snapshot envelope. */
  wrap(data: unknown): unknown;
  /** Execute the live turn. */
  run(): Promise<unknown>;
  /** Settles the caller awaiting the turn's outcome. */
  readonly settle: {
    resolve(value: unknown): void;
    reject(error: unknown): void;
  };
};

/** The host internals one chat-turn definition runs against. */
export type ChatTurnTaskHooks = {
  /** Where turns before checkpoints kept their snapshot. */
  readonly storage: DurableObjectStorage;
  keepAliveWhile<T>(fn: () => Promise<T>): Promise<T>;
  /** The host's fiber stash context, so `this.stash()` keeps working. */
  withStash<T>(
    context: {
      id: string;
      signal: AbortSignal;
      stash: (data: unknown) => void;
    },
    fn: () => Promise<T>
  ): Promise<T>;
  /**
   * Recover the turn of a run replayed after its isolate died
   * (`ChatRecoveryEngine.recoverInterruptedTurn` behind it).
   *
   * @param turn - `persisted` is the snapshot envelope the turn stored, or
   *   `null` when none survived.
   */
  recover(turn: {
    requestId: string;
    persisted: unknown;
    createdAt: number;
  }): Promise<void>;
};

/** The checkpoint entry holding a turn's stash envelope. */
const SNAPSHOT = "snapshot";

/**
 * The storage key a turn accepted before checkpoints kept its snapshot
 * under. Read once by its recovery, then deleted.
 */
function legacySnapshotKey(nonce: string): string {
  return `__cf_chat_turn_snapshot:chat_${nonce}`;
}

/**
 * Build the chat-turn Task handler for one host. Registered under the
 * host's `CHAT_FIBER_NAME` via `Tasks#register`.
 */
export function createChatTurnTaskDefinition(
  hooks: ChatTurnTaskHooks
): (input: unknown, step: TaskStep) => Promise<void> {
  return async (input, step) => {
    const { requestId, nonce } = input as {
      requestId: string;
      nonce: string;
    };
    await step.do(
      "model-turn",
      { retries: { limit: 1 }, timeout: "1 day" },
      async ({ signal }) => {
        const entry = step.local as ChatTurnClosureEntry | undefined;
        if (!entry) {
          // Replay after an unclean interruption: the producing isolate is
          // gone. The turn's last snapshot plus stream evidence drive
          // user-visible recovery.
          const legacyKey = legacySnapshotKey(nonce);
          const persisted =
            step.checkpoint.get(SNAPSHOT) ??
            (await hooks.storage.get(legacyKey)) ??
            null;
          await hooks.recover({
            requestId,
            persisted,
            createdAt: step.createdAt
          });
          await hooks.storage.delete(legacyKey);
          return undefined;
        }
        // SAFETY: chat fiber snapshots are JSON envelopes, as fiber stash
        // data always was.
        step.checkpoint.set(SNAPSHOT, entry.initial as TaskJson);
        try {
          const value = await hooks.keepAliveWhile(() =>
            hooks.withStash(
              {
                id: nonce,
                signal,
                stash: (data) =>
                  step.checkpoint.set(SNAPSHOT, entry.wrap(data) as TaskJson)
              },
              () => entry.run()
            )
          );
          entry.settle.resolve(value);
        } catch (error) {
          entry.settle.reject(error);
          throw error;
        }
        return undefined;
      }
    );
  };
}
