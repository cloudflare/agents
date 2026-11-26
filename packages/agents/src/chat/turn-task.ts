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
import { isTaskSuspension } from "../tasks/replay";
import { TaskSettlement } from "../tasks/settlement";
import type { TaskCheckpoint } from "../tasks/types";
import type { ChatAdmissionInput, ChatAdmissionRecord } from "./admissions";
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
  /** A client request's record, until its turn starts (`admissions.ts`). */
  admission?: ChatAdmissionInput;
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
  /**
   * Run again, inside its run `runId`, a client request whose isolate died
   * before its turn started (`ChatTurns.replayInRun`).
   */
  replay(runId: string, record: ChatAdmissionRecord): Promise<void>;
  /**
   * Keep the parked run `runId` at the head of the chat lane until `reply`
   * ends, then end it (`ChatTurns.parkUntil`).
   */
  parkUntil(runId: string, reply: Promise<void>): void;
  /**
   * Whether a lane run an earlier isolate left parked holds the chat lane
   * for a recovery (`ChatTurns.laneHeldForRecovery`).
   */
  laneHeldForRecovery(): boolean;
  /**
   * Keep those parked runs at the lane's head until `reply` ends as well
   * (`ChatTurns.holdParksUntil`).
   */
  holdParksUntil(reply: Promise<void>): void;
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
 * The field of a lane turn's kept envelope that says its model call ran as
 * a run of its own.
 */
const ELSEWHERE = "__cfElsewhere";

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
): (input: unknown, step: TaskStep) => Promise<void | TaskSettlement> {
  return async (input, step) => {
    const { requestId, nonce, envelope, lane, admission } =
      input as ChatTurnTaskInput;
    let local = step.local as ChatTurnClosureEntry | ChatLaneEntry | undefined;
    // A client request its isolate left before its turn started runs here,
    // in its place in the lane.
    if (
      !local &&
      lane &&
      admission &&
      step.checkpoint.get(SNAPSHOT) === undefined
    ) {
      const record: ChatAdmissionRecord = {
        requestId,
        seq: 0,
        messageIds: admission.messages.map((message) => message.id),
        messages: admission.messages,
        afterUserId: admission.afterUserId,
        strategy: admission.strategy ?? null,
        payload: admission.payload,
        stopped: false,
        createdAt: step.createdAt
      };
      local = {
        lane: true,
        run: (inside) => inside(() => hooks.replay(step.id, record)),
        dropped: () => {}
      };
    }
    // A replay's recovery attempt, journaled as the step's result so a
    // reset during its backoff or dispatch runs the same attempt again.
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
          // A lane turn whose model call ran as a run of its own: that run
          // recovers it.
          if (
            lane &&
            kept &&
            typeof kept === "object" &&
            !Array.isArray(kept) &&
            kept[ELSEWHERE] === true
          ) {
            return null;
          }
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
                if (!journalableAttempt(next)) return false;
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
          // A recovered reply cut off again keeps its next attempt in this
          // run; the lane that waits for the reply waits for that too.
          if (scheduled && !lane) continueHeldLane(step.id, requestId);
          entry.settle.resolve(value);
        } catch (error) {
          entry.settle.reject(error);
          throw error;
        } finally {
          open = false;
          heldTurns.delete(requestId);
        }
        // SAFETY: the attempt is the recovery engine's JSON payload.
        return (scheduled ?? null) as TaskJson;
      }
    );
    if (attempt) return runKeptAttempt(hooks, step, attempt, lane);
  };
}

/**
 * Run the recovery attempt a turn's run kept, in that run: after a live
 * turn's interruption, or after a replay's. A lane turn's attempt holds the
 * lane, so what was sent meanwhile waits for the recovered reply
 * (ChatOrder); the run stays parked at the lane's head until that reply
 * ends, since an attempt awaiting it would hold the job loop the reply
 * needs.
 */
async function runKeptAttempt(
  hooks: ChatTurnTaskHooks,
  step: TaskStep,
  attempt: TaskJson,
  lane: boolean | undefined
): Promise<void | TaskSettlement> {
  const scheduled = attempt as unknown as ChatRecoveryAttemptInput;
  const run = () =>
    runChatRecoveryAttempt(step, hooks.attempts, {
      ...scheduled,
      // Always suspend first, even with no backoff: the attempt then
      // runs from the alarm, where the host keeps the continuation's
      // model turn inside the memory-limit breaker, as the recovery
      // Task did.
      delaySeconds: Math.max(scheduled.delaySeconds, 0.001)
    });
  if (!lane) {
    const release = continuedHolds.get(step.id);
    if (release) {
      // A recovered reply cut off again: its lane is still held for it, and
      // is released when this attempt's own recovered reply ends.
      let reply: Promise<void> | undefined;
      try {
        ({ reply } = await runHoldingLane(run));
      } catch (error) {
        if (isTaskSuspension(error)) throw error;
        continuedHolds.delete(step.id);
        release();
        throw error;
      }
      continuedHolds.delete(step.id);
      if (reply) void reply.finally(release);
      else release();
      return;
    }
    // The recovered turn of an earlier isolate's lane run, cut off by a
    // second reset: it recovers holding the lane that run still holds,
    // so nothing queued behind starts ahead of it.
    if (hooks.laneHeldForRecovery()) {
      const { reply } = await runHoldingLane(run);
      if (reply) hooks.holdParksUntil(reply);
      return;
    }
    await run();
    return;
  }
  // A lane turn replayed after a reset recovers holding the lane, so the
  // requests its isolate left behind it wait for it (ChatOrder), as
  // their records did; the attempt's own turns run in place. The run
  // stays parked at the lane's head until the recovered reply ends: an
  // attempt awaiting it would hold the job loop the reply needs.
  const { reply } = await runHoldingLane(run);
  if (reply) {
    hooks.parkUntil(step.id, reply);
    return TaskSettlement.park("recovered reply");
  }
}

type LaneAttempt = {
  reply?: Promise<void>;
  /** Holds a recovered reply cut off again adds ({@link continueHeldLane}). */
  more: Array<Promise<void>>;
};

/**
 * The release of a held lane, by the run id of the recovered turn that was
 * cut off again and keeps its next attempt. Removed when that attempt ends;
 * a reset loses it with the park it holds, which the turn's run then
 * recovers as an earlier isolate's ({@link ChatTurnTaskHooks.laneHeldForRecovery}).
 */
const continuedHolds = new Map<string, () => void>();

/**
 * The held lanes of the recovered turns a lane run's recovery attempt
 * started, by request id: the turn's run may run in another async context
 * (the alarm's). Removed when the turn's model call ends.
 */
const heldTurns = new Map<string, LaneAttempt>();

/**
 * @internal Note that the turn `requestId` starts in a lane run's recovery
 * attempt, so a cut-off of it keeps that lane ({@link continueHeldLane}).
 */
export function noteHeldTurn(requestId: string): void {
  const held = laneAttempt.getStore();
  if (held) heldTurns.set(requestId, held);
}

/**
 * Keep the lane held for the recovered turn `requestId` after its reply
 * ends, until the attempt its run `runId` kept ends as well.
 */
function continueHeldLane(runId: string, requestId: string): void {
  const held = heldTurns.get(requestId) ?? laneAttempt.getStore();
  if (!held) return;
  held.more.push(
    new Promise<void>((resolve) => continuedHolds.set(runId, resolve))
  );
}

/** Set while the app's `onStart` runs. */
const appStart = new AsyncLocalStorage<true>();

/**
 * @internal Run the app's `onStart`: a turn it queues runs in place, not behind the
 * requests an earlier isolate left, which replay only once it is done.
 */
export function runAppStart<T>(fn: () => Promise<T>): Promise<T> {
  return appStart.run(true, fn);
}

/** Set while a lane run runs its turn's recovery attempt. */
const laneAttempt = new AsyncLocalStorage<LaneAttempt>();

/**
 * Run `fn` as a lane run's recovery attempt ({@link inLaneRecoveryAttempt}).
 * @returns The recovered reply it handed off ({@link holdLaneForReply}),
 * which the lane waits for.
 */
export async function runHoldingLane(
  fn: () => Promise<void>
): Promise<LaneAttempt> {
  const held: LaneAttempt = { more: [] };
  await laneAttempt.run(held, fn);
  return held;
}

/**
 * In a lane run's recovery attempt, keep the lane until `reply` ends.
 * @returns False outside one.
 */
export function holdLaneForReply(reply: Promise<unknown>): boolean {
  const held = laneAttempt.getStore();
  if (!held) return false;
  held.reply = (async () => {
    await reply.then(
      () => {},
      () => {}
    );
    for (let next = held.more.shift(); next; next = held.more.shift()) {
      await next;
    }
  })();
  return true;
}

/**
 * Whether the caller runs in a lane run's recovery attempt: a turn it
 * queues runs in place, not behind the run that holds the lane.
 */
export function inLaneRecoveryAttempt(): boolean {
  return laneAttempt.getStore() !== undefined;
}

/** Whether a turn queued now runs in place (a recovery attempt's, or `onStart`'s). */
export function runsInPlace(): boolean {
  return inLaneRecoveryAttempt() || appStart.getStore() === true;
}

/**
 * A lane turn's attempt in the isolate that queued it: run the turn, and its
 * model call in the run's `model-turn` step. Returns the recovery attempt an
 * interruption inside it planned, which this run then runs.
 */
async function runLaneTurn(
  hooks: ChatTurnTaskHooks,
  step: TaskStep,
  input: ChatTurnTaskInput,
  entry: ChatLaneEntry
): Promise<void | TaskSettlement> {
  const attempt = await step.do(
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
          // its own, whose input keeps it in parts, and which recovers it.
          // This run says so, so a replay of it runs nothing.
          try {
            step.checkpoint.set(SNAPSHOT, {
              [BEGAN_AT]: Date.now(),
              [ELSEWHERE]: true
            });
          } catch (error) {
            console.warn("[chat] turn snapshot not kept:", error);
          }
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
      // A live turn's interruption keeps its recovery attempt here, and
      // this run runs it after the turn, holding the lane, as a replay's.
      let scheduled: ChatRecoveryAttemptInput | undefined;
      let open = true;
      const take = (next: ChatRecoveryAttemptInput): boolean => {
        if (!open || scheduled || !journalableAttempt(next)) return false;
        try {
          // SAFETY: the attempt is the recovery engine's JSON payload.
          step.checkpoint.set(ATTEMPT, next as unknown as TaskJson);
        } catch {
          return false;
        }
        scheduled = next;
        return true;
      };
      try {
        await hooks.keepAliveWhile(() =>
          entry.run((fn) => turnAttempt.run(take, () => laneRun.run(begin, fn)))
        );
      } finally {
        open = false;
      }
      if (failed) throw failed.error;
      // SAFETY: the attempt is the recovery engine's JSON payload.
      return (scheduled ?? null) as TaskJson;
    }
  );
  if (attempt) return runKeptAttempt(hooks, step, attempt, true);
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
