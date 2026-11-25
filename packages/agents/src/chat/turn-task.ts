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

import { AsyncLocalStorage } from "node:async_hooks";
import type { TaskJson, TaskStep } from "../tasks";
import type { TaskCheckpoint } from "../tasks/types";
import type { ChatRecoveryAttemptInput } from "./recovery-engine";
import {
  journalableAttempt,
  runChatRecoveryAttempt,
  type ChatRecoveryTaskHooks
} from "./recovery-task";

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
 * A turn queued on the chat lane (`turn-lane.ts`): the `local` of its run,
 * accepted when it was queued. Its model call runs in the same run.
 */
export type ChatLaneEntry = {
  readonly lane: true;
  /**
   * Run the queued turn in the async context it was queued in, with
   * `inside` (this run's context) entered within it.
   */
  run(inside: <T>(fn: () => Promise<T>) => Promise<T>): Promise<void>;
  /** The run ended without running it (Tasks calls it). A no-op once it ran. */
  dropped(): void;
};

/**
 * Run a lane turn's model call in its own run: keep `envelope` as its
 * recovery snapshot, then run `body` under the fiber stash context. Returns
 * `undefined` (the caller runs the model call as a run of its own) for a
 * second model call of the run, or one under another request id.
 */
export type ChatRunBegin = <T>(
  turn: {
    requestId: string;
    envelope: TaskJson | undefined;
    onStash(data: unknown): void;
  },
  body: () => Promise<T>
) => Promise<T> | undefined;

const laneRun = new AsyncLocalStorage<ChatRunBegin | undefined>();

/** The running lane turn's run, for its model call, or `undefined`. */
export function currentChatRun(): ChatRunBegin | undefined {
  return laneRun.getStore();
}

/**
 * The chat-turn run's input: the request, and what recovery needs to run it
 * again (`envelope`: the turn's snapshot in the stash envelope, with no app
 * data; absent when it cannot be kept as JSON). A lane turn (`lane`) keeps
 * its envelope in the checkpoint when its model call begins.
 */
export type ChatTurnTaskInput = {
  requestId: string;
  continuation: boolean;
  nonce: string;
  envelope?: TaskJson;
  lane?: true;
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
   *   `null` when none survived. `attempt` receives the recovery attempt,
   *   which this run then runs itself.
   */
  recover(turn: {
    requestId: string;
    persisted: unknown;
    createdAt: number;
    attempt: (attempt: ChatRecoveryAttemptInput) => boolean;
  }): Promise<void>;
  /** The host's recovery callbacks, as the recovery Task runs them. */
  readonly attempts: ChatRecoveryTaskHooks;
};

/** The Tasks lane the chat turns of an agent run on, one at a time. */
export const CHAT_TURN_LANE = "chat";

/** Where a live turn's interruption hands its recovery attempt. */
const turnAttempt = new AsyncLocalStorage<
  (attempt: ChatRecoveryAttemptInput) => boolean
>();

/**
 * The running chat turn's own run, as a place for the recovery attempt of an
 * interruption routed inside it, or `undefined` outside a live turn. It
 * declines (returns `false`) once the turn's step has ended, or when the
 * attempt is too large to journal.
 */
export function currentTurnAttempt():
  | ((attempt: ChatRecoveryAttemptInput) => boolean)
  | undefined {
  return turnAttempt.getStore();
}

/** The running chat turn's run checkpoint, for what the host keeps with it. */
const turnCheckpoint = new AsyncLocalStorage<TaskCheckpoint>();

/**
 * The running chat turn's run checkpoint, or `undefined` outside a turn:
 * state the host keeps with the turn (Think's owed response hook), cleared
 * when the turn's run settles. Set inside the turn's model call, and inside
 * the recovery of a replayed turn.
 */
export function currentTurnCheckpoint(): TaskCheckpoint | undefined {
  return turnCheckpoint.getStore();
}

/** The checkpoint entry holding the app's latest `stash()` data. */
const STASH = "stash";
/**
 * The checkpoint entry holding the recovery attempt a live turn's
 * interruption planned, kept at once so a reset before the step ends still
 * runs it.
 */
const ATTEMPT = "attempt";
/**
 * The checkpoint entry holding a lane turn's envelope, written when its
 * model call begins (`null` when it could not be kept). A turn accepted
 * before its input carried the snapshot kept its whole envelope here too.
 */
const SNAPSHOT = "snapshot";
/** The field of a lane turn's kept envelope that says when its model call began. */
const BEGAN_AT = "__cfBeganAt";

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
    const { requestId, nonce, envelope, lane } = input as ChatTurnTaskInput;
    const local = step.local as
      | ChatTurnClosureEntry
      | ChatLaneEntry
      | undefined;
    if (local && "lane" in local) {
      try {
        return await runLaneTurn(
          hooks,
          step,
          input as ChatTurnTaskInput,
          local
        );
      } finally {
        local.dropped();
      }
    }
    // A replay's recovery attempt, journaled as the step's result so a
    // reset during its backoff or dispatch runs the same attempt again.
    const attempt = await step.do(
      "model-turn",
      { retries: { limit: 1 }, timeout: "1 day" },
      async ({ signal }) => {
        const entry = local;
        if (!entry) {
          // The live turn planned its recovery before the isolate died: run
          // that attempt. Its stream already ended as recovering, so the
          // evidence would read the turn as finished.
          const planned = step.checkpoint.get(ATTEMPT);
          if (planned) return planned;
          // Replay after an unclean interruption: the producing isolate is
          // gone. The turn's snapshot and last stash data, plus stream
          // evidence, drive user-visible recovery.
          const legacyKey = legacySnapshotKey(nonce);
          const stash = step.checkpoint.get(STASH);
          const kept = step.checkpoint.get(SNAPSHOT);
          // A lane turn whose model call never began: nothing to recover.
          if (lane && kept === undefined) return null;
          // A lane turn kept its envelope without the app's data; a turn
          // from before its input carried the snapshot kept it whole.
          const laneKept =
            lane && kept && typeof kept === "object" && !Array.isArray(kept)
              ? kept
              : undefined;
          const { [BEGAN_AT]: beganAt, ...laneEnvelope } = laneKept ?? {};
          const persisted =
            (laneKept
              ? {
                  // A snapshot that could not be kept is null, so the
                  // app's data is not read as one.
                  [hooks.snapshotKey]: null,
                  ...laneEnvelope,
                  user: stash ?? null
                }
              : (kept ?? undefined)) ??
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
          let scheduled: ChatRecoveryAttemptInput | undefined;
          await turnCheckpoint.run(step.checkpoint, () =>
            hooks.recover({
              requestId,
              persisted,
              createdAt: typeof beganAt === "number" ? beganAt : step.createdAt,
              attempt: (next) => {
                // A lane turn's attempt would hold the lane: the Task takes it.
                if (lane || !journalableAttempt(next)) return false;
                scheduled = next;
                return true;
              }
            })
          );
          await hooks.storage.delete(legacyKey);
          // SAFETY: the attempt is the recovery engine's JSON payload.
          return (scheduled ?? null) as TaskJson;
        }
        // An interruption routed inside the live turn plans its recovery
        // attempt here, and this run runs it after the turn, as a replay does.
        let scheduled: ChatRecoveryAttemptInput | undefined;
        let open = true;
        const take = (next: ChatRecoveryAttemptInput): boolean => {
          if (!open || scheduled || !journalableAttempt(next)) return false;
          try {
            // SAFETY: the attempt is the recovery engine's JSON payload.
            step.checkpoint.set(ATTEMPT, next as unknown as TaskJson);
          } catch {
            // Not kept: the recovery Task takes it, durably, instead.
            return false;
          }
          scheduled = next;
          return true;
        };
        try {
          const value = await hooks.keepAliveWhile(() =>
            entry.run((fn) =>
              turnAttempt.run(take, () =>
                turnCheckpoint.run(step.checkpoint, () =>
                  hooks.withStash(
                    {
                      id: nonce,
                      signal,
                      stash: (data) => {
                        entry.onStash(data);
                        keepStash(step, data);
                      }
                    },
                    fn
                  )
                )
              )
            )
          );
          entry.settle.resolve(value);
        } catch (error) {
          entry.settle.reject(error);
          throw error;
        } finally {
          open = false;
        }
        // SAFETY: the attempt is the recovery engine's JSON payload.
        return (scheduled ?? null) as TaskJson;
      }
    );
    if (attempt) {
      const scheduled = attempt as unknown as ChatRecoveryAttemptInput;
      await runChatRecoveryAttempt(step, hooks.attempts, {
        ...scheduled,
        // Always suspend first, even with no backoff: the attempt then runs
        // from the alarm, where the host keeps the continuation's model turn
        // inside the memory-limit breaker, as the recovery Task did.
        delaySeconds: Math.max(scheduled.delaySeconds, 0.001)
      });
    }
  };
}

/**
 * A lane turn's attempt in the isolate that queued it: run the turn, and its
 * model call in the run's `model-turn` step. An interruption's recovery
 * attempt goes to the recovery Task: one in this run would hold the lane,
 * and the turns queued behind it, through its backoff.
 */
async function runLaneTurn(
  hooks: ChatTurnTaskHooks,
  step: TaskStep,
  input: ChatTurnTaskInput,
  entry: ChatLaneEntry
): Promise<void> {
  await step.do(
    "model-turn",
    { retries: { limit: 1 }, timeout: "1 day" },
    async ({ signal }) => {
      let begun = false;
      // What the model call threw fails the run, as a run of its own did.
      let failed: { error: unknown } | undefined;
      const begin: ChatRunBegin = (turn, body) => {
        if (begun || turn.requestId !== input.requestId) return undefined;
        // Kept with when the model call began: recovery ages the turn from
        // then, not from when it was queued.
        const kept: TaskJson =
          turn.envelope && typeof turn.envelope === "object"
            ? { ...turn.envelope, [BEGAN_AT]: Date.now() }
            : { [BEGAN_AT]: Date.now() };
        try {
          step.checkpoint.set(SNAPSHOT, kept);
        } catch {
          // Too large for the run's row: the model call runs as a run of
          // its own, whose input keeps it in parts.
          return undefined;
        }
        begun = true;
        // A turn its model call starts runs as a run of its own.
        return laneRun.run(undefined, () =>
          turnCheckpoint.run(step.checkpoint, () =>
            hooks.withStash(
              {
                id: input.nonce,
                signal,
                stash: (data) => {
                  turn.onStash(data);
                  keepStash(step, data);
                }
              },
              async () => {
                try {
                  return await body();
                } catch (error) {
                  failed = { error };
                  throw error;
                }
              }
            )
          )
        );
      };
      await hooks.keepAliveWhile(() =>
        entry.run((fn) =>
          turnAttempt.run(
            () => false,
            () => laneRun.run(begin, fn)
          )
        )
      );
      if (failed) throw failed.error;
      return null;
    }
  );
}

/**
 * Keep the app's `stash()` data in the run's checkpoint. Stash data is a
 * hint for recovery; stream cursors are the evidence. Data that cannot be
 * kept is skipped, and never fails the turn.
 */
function keepStash(step: TaskStep, data: unknown): void {
  try {
    // SAFETY: stash data is JSON, as fiber stash data always was; the write
    // throws on anything else. `stash(undefined)` clears the data, as the
    // envelope with no `user` field did.
    step.checkpoint.set(STASH, (data ?? null) as TaskJson);
  } catch (error) {
    console.warn("[chat] turn stash data not kept:", error);
  }
}
