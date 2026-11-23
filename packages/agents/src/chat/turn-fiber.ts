/**
 * Running one chat turn as a durable fiber, shared by `AIChatAgent` and
 * `Think`.
 *
 * Every turn that calls the model runs inside a fiber, so an isolate that
 * dies mid-turn leaves a snapshot chat recovery can start from. Both hosts
 * wrote the same steps around it:
 *
 * - keep the turn's start time and latest `stash()` data while it runs, for
 *   a stream failure that is recovered while the turn is still live;
 * - wrap the snapshot and the app's stash data into one envelope;
 * - a turn that continues the latest reply takes that reply over from a
 *   recovery scheduled to continue it at the stream's first chunk with
 *   content, and not before: a turn that ends earlier (a repair or a hook
 *   throws, the model call fails, in its stream too, or returns nothing)
 *   leaves the recovery in place;
 * - a recovery attempt's turn that throws does not fail its fiber: the
 *   attempt owns the turn, and a failed fiber would be recovered again as
 *   an interrupted turn;
 * - start the chat-turn Task with the live closure as its `local`
 *   ({@link createChatTurnTaskDefinition} runs it) and wait for its
 *   outcome. A facet's turn runs on Tasks too: its run lives on the facet
 *   and the root's alarm wakes it.
 *
 * The host supplies its fiber and Task plumbing and the snapshot.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { wrapChatFiberSnapshot, type ChatFiberSnapshot } from "./recovery";
import { isTurnStopped } from "./turn-stop";
import { isDurableObjectMemoryLimitReset } from "../retries";
import type { ChatTurnClosureEntry } from "./turn-task";

/** What {@link ChatTurnFibers} needs from the agent that hosts it. */
export interface ChatTurnFiberHost {
  /** The name of the host's chat-turn Task definition and fiber. */
  fiberName: string;
  /** The key the turn's snapshot is stored under in the stash envelope. */
  snapshotKey: string;
  /** Mint the nonce a turn's run id is made from. */
  generateId(): string;
  /** The abort signal of the turn running under `requestId`, if it has one. */
  turnSignal(requestId: string): AbortSignal | undefined;
  /** Start the chat-turn Task, with the turn's closure as its `local`. */
  runTask(
    input: {
      requestId: string;
      continuation: boolean;
      nonce: string;
    },
    local: ChatTurnClosureEntry
  ): Promise<unknown>;
  /**
   * Wrap a turn body so a turn that continues the latest reply can take it
   * over from a scheduled recovery (`ChatRecoveryEngine.turnBody`). The
   * request id lets a stop by it reach a recovery attempt whose turn this is.
   */
  turnBody<T>(
    continuation: boolean,
    body: (takeReply: () => Promise<void>) => Promise<T>,
    requestId: string
  ): () => Promise<T>;
  /**
   * The turn's fiber is durably accepted: recovery owns the turn from now
   * on (`ChatTurns.turnAccepted`). Optional.
   */
  turnAccepted?(requestId: string): void;
  /**
   * Whether the caller is a recovery attempt (`ChatRecoveryEngine.inAttempt`).
   * Optional: a host without one never runs a turn for an attempt.
   */
  inRecoveryAttempt?(): boolean;
}

/** One turn to run as a fiber. */
export interface ChatTurnFiber {
  requestId: string;
  /** Whether the turn continues the latest reply. */
  continuation: boolean;
  /** The turn's recovery snapshot, taken before it produces anything. */
  snapshot: ChatFiberSnapshot<string>;
  /**
   * Called once the fiber is durably accepted and before the turn runs, so
   * the host can move ownership (a recovered submission) to this turn.
   */
  onAccepted?(requestId: string): void;
}

export class ChatTurnFibers {
  /**
   * Start time and latest `stash()` data of each turn running in this
   * isolate, by request id. A live stream failure is recovered while the
   * turn still runs, so `onChatRecovery` reads these, not a fiber snapshot.
   */
  readonly liveTurns = new Map<
    string,
    {
      createdAt: number;
      recoveryData: unknown;
      snapshot: ChatFiberSnapshot<string>;
    }
  >();
  constructor(private readonly host: ChatTurnFiberHost) {}

  /**
   * The tools and body the turn running under `requestId` was started with,
   * or `undefined` when no such turn runs here. A live stream failure
   * schedules its recovery with these, not with the stored request context:
   * a turn whose caller pinned its context never wrote it there.
   */
  requestContext(requestId: string):
    | {
        lastBody: ChatFiberSnapshot["lastBody"];
        lastClientTools: ChatFiberSnapshot["lastClientTools"];
      }
    | undefined {
    const snapshot = this.liveTurns.get(requestId)?.snapshot;
    return (
      snapshot && {
        lastBody: snapshot.lastBody,
        lastClientTools: snapshot.lastClientTools
      }
    );
  }

  /**
   * Run `fn`, the turn's model call and reply, as a durable fiber.
   *
   * @param fn - Receives `takeReply`. Call it at the stream's first chunk
   *   that carries content (`takeAtFirstContent`), before that chunk is
   *   streamed or stored: from
   *   then on this turn is the one continuing the reply, and a recovery
   *   scheduled to continue the same reply stands down. It does nothing for
   *   a turn that starts a new reply, and nothing the second time.
   */
  async run<T>(
    turn: ChatTurnFiber,
    fn: (takeReply: () => Promise<void>) => Promise<T>
  ): Promise<T> {
    const { requestId, continuation, snapshot } = turn;
    const liveTurn = {
      createdAt: Date.now(),
      recoveryData: null as unknown,
      snapshot
    };
    const wrap = (data: unknown) => {
      liveTurn.recoveryData = data;
      return wrapChatFiberSnapshot(this.host.snapshotKey, snapshot, data);
    };
    const run = this.host.turnBody(continuation, fn, requestId);
    // What a stopped turn throws because of the stop is not a failure
    // (`isTurnStopped`), so the fiber does not fail with it: the engine
    // would log it and hand it to the agent's `onError`. The caller still
    // gets the throw, and ends the turn `aborted`. The signal is read now:
    // the turn drops its controller before the throw gets here.
    const signal = this.host.turnSignal(requestId);
    // A recovery attempt's turn that throws is the attempt's to run again:
    // it records the outcome, or defers and is delivered again. A fiber
    // that failed would be replayed as an interrupted turn as well, a
    // second owner of the reply that a stop of the attempt does not reach.
    const attemptOwnsIt = this.host.inRecoveryAttempt?.() ?? false;
    let stopped: { error: unknown } | undefined;
    const body = async (): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        if (
          !isTurnStopped(signal) &&
          !(attemptOwnsIt && !isDurableObjectMemoryLimitReset(error))
        ) {
          throw error;
        }
        stopped = { error };
        // SAFETY: never returned to the caller, which gets the throw below.
        return undefined as T;
      }
    };
    /** Give the caller what the stopped or attempt's turn threw. */
    const settled = (value: T): T => {
      if (stopped) throw stopped.error;
      return value;
    };

    this.liveTurns.set(requestId, liveTurn);
    try {
      return settled(await this.#runAsTask(turn, wrap, body));
    } finally {
      if (this.liveTurns.get(requestId) === liveTurn) {
        this.liveTurns.delete(requestId);
      }
    }
  }

  async #runAsTask<T>(
    turn: ChatTurnFiber,
    wrap: (data: unknown) => unknown,
    body: () => Promise<T>
  ): Promise<T> {
    const { requestId, continuation } = turn;
    const nonce = this.host.generateId();
    let resolveOutcome!: (value: unknown) => void;
    let rejectOutcome!: (error: unknown) => void;
    const outcome = new Promise<unknown>((resolve, reject) => {
      resolveOutcome = resolve;
      rejectOutcome = reject;
    });
    // A rejection can land while the Task start is still awaited, before
    // the outcome is awaited below. Mark it handled so the runtime does not
    // report an unhandled rejection this function is about to consume.
    outcome.catch(() => {});
    // The turn runs in the async context of this call (its connection, its
    // request, a caller's result capture), whichever attempt claims it: the
    // caller's, or the alarm's when that claims the run first.
    const inCaller = AsyncLocalStorage.snapshot();
    await this.host.runTask(
      { requestId, continuation, nonce },
      {
        initial: wrap(null),
        wrap,
        run: () => {
          // Tasks accepted the run durably before it invokes the closure.
          this.host.turnAccepted?.(requestId);
          turn.onAccepted?.(requestId);
          return inCaller(body);
        },
        settle: { resolve: resolveOutcome, reject: rejectOutcome }
      }
    );
    return (await outcome) as T;
  }
}
