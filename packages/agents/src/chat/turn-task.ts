/**
 * The chat-turn Task definition, shared by `AIChatAgent` and `Think`.
 *
 * Every chat turn runs as one journaled step on the `tasks` capability. A
 * live turn executes its closure under the fiber stash context (so
 * `this.stash()` keeps persisting the recovery snapshot into host storage);
 * a replay whose closure is gone — the producing isolate died — drives the
 * same recovery seam the legacy fiber scan used, so the ChatRecoveryEngine
 * and every hook behind it are unchanged. Hosts supply their protected
 * internals through {@link ChatTurnTaskHooks}; the turn logic, the snapshot
 * key vocabulary, and the settle plumbing live here once.
 */

import type { FiberRecoveryContext } from "agents";
import type { TaskStep } from "../tasks";

/** One live turn closure, registered under its nonce while this isolate runs it. */
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
  /** The registered definition name (the host's `CHAT_FIBER_NAME`). */
  readonly definitionName: string;
  readonly storage: DurableObjectStorage;
  /** The run row's creation time, for recovery staleness accounting. */
  getRunCreatedAt(runId: string): Promise<number | null>;
  getLiveClosure(nonce: string): ChatTurnClosureEntry | undefined;
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
  /** The unchanged recovery seam (ChatRecoveryEngine behind it). */
  handleRecovery(ctx: FiberRecoveryContext): Promise<unknown>;
};

/** Durable snapshot key for one chat turn's stash envelope. */
function turnSnapshotKey(runId: string): string {
  return `__cf_chat_turn_snapshot:${runId}`;
}

/**
 * Build the chat-turn Task handler for one host. Registered under the
 * host's `CHAT_FIBER_NAME` via `_registerInternalTaskDefinition`.
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
        const runId = `chat_${nonce}`;
        const snapshotKey = turnSnapshotKey(runId);
        const entry = hooks.getLiveClosure(nonce);
        if (!entry) {
          // Replay after an unclean interruption: the producing isolate is
          // gone. The durably persisted turn snapshot plus stream evidence
          // drive user-visible recovery.
          const persisted = await hooks.storage.get(snapshotKey);
          const createdAt = (await hooks.getRunCreatedAt(runId)) ?? Date.now();
          await hooks.handleRecovery({
            id: runId,
            name: `${hooks.definitionName}:${requestId}`,
            snapshot: (persisted ?? null) as unknown,
            createdAt,
            recoveryReason: "interrupted"
          });
          await hooks.storage.delete(snapshotKey);
          return undefined;
        }
        // SAFETY: chat fiber snapshots are the same JSON envelopes the
        // legacy stash wrapper persisted; storage round-trips them.
        await hooks.storage.put(snapshotKey, entry.initial);
        try {
          const value = await hooks.keepAliveWhile(() =>
            hooks.withStash(
              {
                id: nonce,
                signal,
                stash: (data) =>
                  void hooks.storage
                    .put(snapshotKey, entry.wrap(data))
                    .catch(() => {})
              },
              () => entry.run()
            )
          );
          entry.settle.resolve(value);
        } catch (error) {
          entry.settle.reject(error);
          throw error;
        } finally {
          void hooks.storage.delete(snapshotKey).catch(() => {});
        }
        return undefined;
      }
    );
  };
}
