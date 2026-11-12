/**
 * A turn the server starts itself: `saveMessages`, `continueLastTurn`, the
 * recovery retry. The counterpart of `ChatTurns.runClientRequest`, which runs
 * a request a client sent.
 *
 * Both hosts repeated the same steps around each of these turns. This module
 * owns them once:
 *
 * - the turn runs under the queue generation it was admitted with, and ends
 *   `skipped` when the chat was reset since, checked after every step that
 *   can wait;
 * - its abort controller exists from admission, with the caller's signal
 *   linked to it, so a stop that lands while the turn waits in the queue is
 *   not lost;
 * - a turn stopped before its messages are stored stores nothing, and a turn
 *   stopped before its model call never calls the model;
 * - however the turn ends, the controller leaves the registry and the
 *   listener leaves the caller's signal;
 * - the status the caller gets says what happened: a reset turns `completed`
 *   into `skipped`, a stop turns it into `aborted`.
 *
 * What the turn stores and how it calls the model stay with the host.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import type { AbortRegistry } from "./abort-registry";
import type { SaveMessagesResult } from "./lifecycle";
import type { TurnQueue } from "./turn-queue";

export type ServerTurnStatus = SaveMessagesResult["status"];

/** How a server-started turn ended. */
export interface ServerTurnOutcome {
  status: ServerTurnStatus;
  /** The error message, when `status` is `"error"`. */
  error?: string;
}

/** What `prepare` hands back: the input to store, or a reason to stop. */
export type ServerTurnPrepared<TInput> =
  | { input: TInput }
  | {
      /** End the turn here with this status. Nothing is stored. */
      declined: Extract<ServerTurnStatus, "aborted" | "skipped">;
    };

/**
 * One server-started turn, as {@link runServerTurn} runs it. The core owns
 * the order of the steps; the host supplies what each step does. `TInput` is
 * whatever the host's `prepare` hands to its `persist` and `run`.
 */
export interface ServerChatTurn<TInput = undefined> {
  requestId: string;
  /** The caller's signal. Aborting it stops the turn, queued or running. */
  signal?: AbortSignal;
  /**
   * Admit the turn through the host's own queue wrapper (tracing, hooks,
   * keep-alive), and report whether it ran or was skipped as stale. `turn`
   * resolves with the turn's status once its work is done. A host that
   * already holds the queue runs `turn` directly.
   */
  enqueue(
    turn: () => Promise<ServerTurnStatus>,
    generation: number
  ): Promise<"completed" | "stale">;
  /**
   * Work out what the turn stores, at the front of the queue. This step may
   * wait (a messages function, an app callback) and must store nothing: the
   * chat can be reset or the turn stopped while it waits.
   *
   * @param context.isCurrent - `false` once the chat was reset since the
   *   turn was admitted. Check it after a wait, before asking the app
   *   anything more; the core ends the turn `skipped` whatever is returned,
   *   unless the host declined.
   */
  prepare?(context: {
    isCurrent: () => boolean;
  }): Promise<ServerTurnPrepared<TInput>>;
  /** Store the turn's messages and show them to clients. */
  persist?(input: TInput): Promise<void>;
  /**
   * Call the model and stream the reply. `signal` aborts when the turn is
   * stopped or the chat is reset. Return nothing when there was no reply.
   */
  run(signal: AbortSignal, input: TInput): Promise<ServerTurnOutcome | void>;
  /**
   * The turn ended `aborted` and `run` never reported it: the stop landed
   * before the model call, so `run` was not called, or `run` finished
   * without a reply. The host's reply path saw no aborted outcome, so do
   * here what it does for one, such as clearing the terminal record of an
   * earlier failure. Not called for a turn `prepare` declined.
   */
  onAborted?(): void | Promise<void>;
}

/** The parts of the turn core a server-started turn runs on. */
export interface ServerTurnParts {
  queue: TurnQueue;
  aborts: AbortRegistry;
}

/**
 * Run one server-started turn, start to finish:
 *
 * 1. Capture the queue generation, create the turn's abort controller and
 *    link the caller's signal to it. A stop from here on reaches the turn.
 * 2. Queue the turn.
 * 3. At the front of the queue: `prepare`, then `persist`, then `run`. Before
 *    each one, a reset ends the turn `skipped` and a stop ends it `aborted`.
 *    So a turn stopped while it waited, or while `prepare` waited, stores
 *    nothing, and a turn stopped at any point before `run` never calls the
 *    model.
 * 4. A turn the host's `prepare` declined ends with the status it gave,
 *    reset or not.
 * 5. Whatever happened, drop the controller and detach the caller's signal,
 *    then map the status.
 */
export async function runServerTurn<TInput = undefined>(
  parts: ServerTurnParts,
  turn: ServerChatTurn<TInput>
): Promise<ServerTurnOutcome> {
  const { queue, aborts } = parts;
  const { requestId } = turn;
  const generation = queue.generation;
  const isCurrent = () => queue.generation === generation;

  // The registry hands out a signal for every string id. Anything else
  // would give a turn no stop can reach.
  const signal = aborts.getSignal(requestId);
  if (!signal) {
    throw new TypeError("runServerTurn: requestId must be a string");
  }
  const detachExternal = aborts.linkExternal(requestId, turn.signal);
  let released = false;
  // Runs when the turn's work ends, and again after the queue for a turn
  // that never started. `_reply` and a reset can remove the controller
  // earlier; the captured signal still says whether it aborted.
  const release = () => {
    if (released) return;
    released = true;
    detachExternal();
    aborts.remove(requestId);
  };

  let outcome: ServerTurnOutcome = { status: "completed" };
  // Whether the host already dealt with an aborted outcome: its reply path
  // reported one, or its `prepare` declined the turn.
  let hostSawAbort = false;

  /** `true` when the turn must end here: reset since admission, or stopped. */
  const endsHere = (): boolean => {
    if (!isCurrent()) {
      outcome = { status: "skipped" };
      return true;
    }
    // The outcome stays `completed`; the mapping below turns it into
    // `aborted` and the host hears of it through `onAborted`.
    return signal.aborted;
  };

  const body = async (): Promise<void> => {
    if (endsHere()) return;
    let input = undefined as TInput;
    if (turn.prepare) {
      const prepared = await turn.prepare({ isCurrent });
      if ("declined" in prepared) {
        outcome = { status: prepared.declined };
        hostSawAbort = true;
        return;
      }
      if (endsHere()) return;
      input = prepared.input;
    }
    if (turn.persist) {
      await turn.persist(input);
      if (endsHere()) return;
    }
    const ran = await turn.run(signal, input);
    if (ran) {
      outcome = ran;
      hostSawAbort = ran.status === "aborted";
    }
  };

  try {
    const admitted = await turn.enqueue(async () => {
      try {
        await body();
      } finally {
        release();
      }
      outcome = mapServerTurnOutcome(outcome, {
        reset: !isCurrent(),
        aborted: signal.aborted
      });
      if (outcome.status === "aborted" && !hostSawAbort) {
        await turn.onAborted?.();
      }
      return outcome.status;
    }, generation);
    if (admitted === "stale") outcome = { status: "skipped" };
  } finally {
    release();
  }

  // A reset can land between the turn's end and the queue handing back.
  return mapServerTurnOutcome(outcome, { reset: !isCurrent(), aborted: false });
}

/**
 * The status a caller gets for a turn that reported `completed`: `skipped`
 * when the chat was reset since the turn was admitted, `aborted` when the
 * turn was stopped. A reset wins: nothing of the turn is left to report.
 * Any other status stands, so an error stays an error.
 */
export function mapServerTurnOutcome(
  outcome: ServerTurnOutcome,
  state: { reset: boolean; aborted: boolean }
): ServerTurnOutcome {
  if (outcome.status !== "completed") return outcome;
  if (state.reset) return { status: "skipped" };
  if (state.aborted) return { status: "aborted" };
  return outcome;
}

/**
 * The `prepare` step of a turn that stores messages (`saveMessages`): work
 * out the messages, asking the app whether the turn should still apply.
 *
 * `shouldApply` is asked before the messages are worked out and again after,
 * because a messages function can wait. `false` declines the turn as
 * `aborted` with nothing stored. After a reset the app is not asked again:
 * the turn is over, and the core ends it `skipped`.
 */
export async function prepareTurnMessages<TMessage>(options: {
  /** The messages to store, or a function of the transcript at turn start. */
  messages:
    | TMessage[]
    | ((current: TMessage[]) => TMessage[] | Promise<TMessage[]>);
  /** The stored transcript, read when the turn starts. */
  current: () => TMessage[];
  /** Whether the turn should still store its messages and run. */
  shouldApply?: () => boolean | Promise<boolean>;
  /** `false` once the chat was reset since the turn was admitted. */
  isCurrent: () => boolean;
}): Promise<ServerTurnPrepared<TMessage[]>> {
  const { messages, shouldApply, isCurrent } = options;
  if (shouldApply && !(await shouldApply())) return { declined: "aborted" };
  const input =
    typeof messages === "function"
      ? await messages(options.current())
      : messages;
  if (!isCurrent()) return { input };
  if (shouldApply && !(await shouldApply())) return { declined: "aborted" };
  return { input };
}
