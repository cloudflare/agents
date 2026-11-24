/**
 * The chat-turn Task definition, shared by `AIChatAgent` and `Think`.
 *
 * Every chat turn runs as one journaled step on the `tasks` capability. The
 * run's input is the request and its snapshot (what recovery needs to run
 * it again). A live turn executes its closure (the run's `local`) under the
 * fiber stash context, so `this.stash()` writes the app's data into the
 * run's checkpoint; a replay whose closure is gone (the producing isolate
 * died) hands the snapshot and that data to the host's chat recovery. Hosts supply their
 * protected internals through {@link ChatTurnTaskHooks}; the turn logic, the
 * snapshot key vocabulary, and the settle plumbing live here once.
 */

import type { TaskJson, TaskStep } from "../tasks";

/** One live turn closure: the `local` value of the turn's run in this isolate. */
export type ChatTurnClosureEntry = {
  /** The app's `stash()` data, as it is kept for recovery. */
  onStash(data: unknown): void;
  /**
   * Execute the live turn in its caller's async context, with `inside`
   * (the turn's fiber stash context) entered within it.
   */
  run(inside: <T>(fn: () => Promise<T>) => Promise<T>): Promise<unknown>;
  /** Settles the caller awaiting the turn's outcome. */
  readonly settle: {
    resolve(value: unknown): void;
    reject(error: unknown): void;
  };
};

/**
 * The chat-turn run's input: the request, and what recovery needs to run it
 * again (`envelope`: the turn's snapshot in the stash envelope, with no app
 * data; absent when it cannot be kept as JSON).
 */
export type ChatTurnTaskInput = {
  requestId: string;
  continuation: boolean;
  nonce: string;
  envelope?: TaskJson;
};

/** The host internals one chat-turn definition runs against. */
export type ChatTurnTaskHooks = {
  /** Where turns before checkpoints kept their snapshot. */
  readonly storage: DurableObjectStorage;
  /** The key the host's stash envelope keeps its snapshot under. */
  readonly snapshotKey: string;
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

/** The checkpoint entry holding the app's latest `stash()` data. */
const STASH = "stash";
/**
 * The checkpoint entry a turn accepted before its input carried the
 * snapshot kept its whole envelope under. Read by its recovery only.
 */
const LEGACY_ENVELOPE = "snapshot";

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
    const { requestId, nonce, envelope } = input as ChatTurnTaskInput;
    await step.do(
      "model-turn",
      { retries: { limit: 1 }, timeout: "1 day" },
      async ({ signal }) => {
        const entry = step.local as ChatTurnClosureEntry | undefined;
        if (!entry) {
          // Replay after an unclean interruption: the producing isolate is
          // gone. The turn's snapshot and last stash data, plus stream
          // evidence, drive user-visible recovery.
          const legacyKey = legacySnapshotKey(nonce);
          const stash = step.checkpoint.get(STASH);
          const persisted =
            step.checkpoint.get(LEGACY_ENVELOPE) ??
            (envelope &&
            typeof envelope === "object" &&
            !Array.isArray(envelope)
              ? { ...envelope, user: stash ?? null }
              : ((await hooks.storage.get(legacyKey)) ??
                // No snapshot was kept (it could not be): recovery still
                // gets the app's data, in an envelope whose snapshot is
                // null, so data shaped like an envelope is not read as one.
                (stash !== undefined
                  ? { [hooks.snapshotKey]: null, user: stash }
                  : null)));
          await hooks.recover({
            requestId,
            persisted,
            createdAt: step.createdAt
          });
          await hooks.storage.delete(legacyKey);
          return undefined;
        }
        try {
          const value = await hooks.keepAliveWhile(() =>
            entry.run((fn) =>
              hooks.withStash(
                {
                  id: nonce,
                  signal,
                  stash: (data) => {
                    entry.onStash(data);
                    // Stash data is a hint for recovery; stream cursors are
                    // the evidence. Data that cannot be kept is skipped,
                    // and never fails the turn.
                    try {
                      // SAFETY: stash data is JSON, as fiber stash data
                      // always was; the write throws on anything else.
                      // `stash(undefined)` clears the data, as the envelope
                      // with no `user` field did.
                      step.checkpoint.set(STASH, (data ?? null) as TaskJson);
                    } catch (error) {
                      console.warn("[chat] turn stash data not kept:", error);
                    }
                  }
                },
                fn
              )
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
