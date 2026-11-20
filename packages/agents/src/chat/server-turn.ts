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
 * - the status the caller gets says what happened: a reset gives `skipped`,
 *   a stop before any reply gives `aborted`, an error stays an error, and
 *   what the reply path reported stands.
 *
 * What the turn stores and how it calls the model stay with the host.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import type { AbortRegistry } from "./abort-registry";
import type { AbortedTurnReason, SaveMessagesResult } from "./lifecycle";
import type { TurnQueue } from "./turn-queue";
import { isTurnStopped } from "./turn-stop";

export type ServerTurnStatus = SaveMessagesResult["status"];

/** How a server-started turn ended. */
export interface ServerTurnOutcome {
  status: ServerTurnStatus;
  /** The error message, when `status` is `"error"`. */
  error?: string;
  /**
   * Why the turn is `aborted`. A reply path sets `"interrupted"` for a turn
   * it handed to recovery. The core fills in `"stopped"` for every other
   * aborted turn, and drops the field for any other status.
   */
  reason?: AbortedTurnReason;
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
   * What it throws after `signal` aborted is the stop, not a failure
   * ({@link isTurnStopped}): the turn ends `aborted`.
   */
  run(signal: AbortSignal, input: TInput): Promise<ServerTurnOutcome | void>;
  /**
   * The turn ended `aborted` after it stored its messages, and `run` never
   * reported it: the stop landed between `persist` and the model call, or
   * `run` finished without a reply. The host's reply path saw no aborted
   * outcome, so do here what it does for one, such as clearing the terminal
   * record of an earlier failure: the conversation moved.
   *
   * Not called for a turn that stored nothing and never ran, for a turn
   * `prepare` declined, or for a turn the chat was reset under.
   */
  onAborted?(): void | Promise<void>;
}

/** The parts of the turn core a server-started turn runs on. */
export interface ServerTurnParts {
  queue: TurnQueue;
  aborts: AbortRegistry;
  /**
   * Link the caller's signal to the turn. `ChatTurns` passes its own
   * `linkExternal`, so a signal that stops the running turn is a stop like
   * any other and drops the continuations waiting on it. Defaults to the
   * registry's plain link.
   */
  linkExternal?: (
    requestId: string,
    signal: AbortSignal | undefined
  ) => () => void;
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
  const detachExternal = parts.linkExternal
    ? parts.linkExternal(requestId, turn.signal)
    : aborts.linkExternal(requestId, turn.signal);
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
  // The host's `prepare` declined the turn: its status stands, reset or not.
  let declined = false;
  // The host's `run` reported an outcome through its reply path.
  let reported = false;
  // The turn stored its messages or called the model.
  let touched = false;

  /** `true` when the turn must end here: reset since admission, or stopped. */
  const endsHere = (): boolean => !isCurrent() || signal.aborted;

  const body = async (): Promise<void> => {
    if (endsHere()) return;
    let input = undefined as TInput;
    if (turn.prepare) {
      const prepared = await turn.prepare({ isCurrent });
      if ("declined" in prepared) {
        outcome = { status: prepared.declined };
        declined = true;
        return;
      }
      if (endsHere()) return;
      input = prepared.input;
    }
    // From here the turn stores its messages or calls the model.
    touched = true;
    if (turn.persist) {
      await turn.persist(input);
      if (endsHere()) return;
    }
    let ran: ServerTurnOutcome | void = undefined;
    try {
      ran = await turn.run(signal, input);
    } catch (error) {
      // What a stopped turn throws because of the stop is not a failure:
      // the turn ends `aborted`, like one stopped before `run`.
      if (!isTurnStopped(signal)) throw error;
    }
    if (ran) {
      outcome = ran;
      reported = true;
    }
  };

  try {
    const admitted = await turn.enqueue(async () => {
      try {
        await body();
      } finally {
        release();
      }
      if (!declined) {
        outcome = mapServerTurnOutcome(outcome, {
          reset: !isCurrent(),
          aborted: signal.aborted,
          reported
        });
        // The reply path deals with the aborted outcomes it reports. A turn
        // that did nothing leaves the host's state as it found it.
        if (outcome.status === "aborted" && !reported && touched) {
          await turn.onAborted?.();
        }
      }
      return outcome.status;
    }, generation);
    if (admitted === "stale") outcome = { status: "skipped" };
  } finally {
    release();
  }

  // The status was settled when the turn's work ended. A reset that lands
  // later, while the host's queue wrapper is still busy with the turn (its
  // `onChatResponse`), changes nothing about a turn that already finished.
  return {
    status: outcome.status,
    ...(outcome.error !== undefined && { error: outcome.error }),
    // `aborted` always says why. Only a reply path knows of an interruption;
    // everything else that aborts a turn is a stop.
    ...(outcome.status === "aborted" && {
      reason: outcome.reason ?? "stopped"
    })
  };
}

/**
 * The status a caller gets for a turn.
 *
 * - An `error` stands.
 * - A reply the host's reply path reported `completed` stands: it finished
 *   and was stored. A stop or a reset that lands afterwards, while the
 *   response hook runs, does not undo it.
 * - Otherwise a reset since the turn was admitted gives `skipped`. Nothing
 *   of the turn is left to report, whether the reset came before the reply
 *   or cut it off.
 * - A turn stopped before its reply path reported anything (`run` was not
 *   called, or returned nothing) is `aborted`.
 * - An `aborted` the reply path reported stands, absent a reset.
 */
export function mapServerTurnOutcome(
  outcome: ServerTurnOutcome,
  state: {
    /** The chat was reset since the turn was admitted. */
    reset: boolean;
    /** The turn's signal aborted. */
    aborted: boolean;
    /** The host's reply path reported `outcome`. */
    reported: boolean;
  }
): ServerTurnOutcome {
  if (outcome.status === "error") return outcome;
  if (state.reported && outcome.status === "completed") return outcome;
  if (state.reset) return { status: "skipped" };
  if (!state.reported && state.aborted) return { status: "aborted" };
  return outcome;
}

/**
 * The tools and body a caller passes with a turn: an agent-tool run's input,
 * or what a recovered turn was running with. A field left out means "the
 * stored one, read when the turn starts"; `null` pins "none".
 *
 * A pinned context is that turn's only. It is never written to the stored
 * request context, so it cannot leak into the chat's next turn, and nothing
 * has to be put back when the turn ends.
 */
export interface PinnedTurnContext<TClientTool = unknown> {
  clientTools?: TClientTool[] | null;
  body?: Record<string, unknown> | null;
}

/**
 * The tools or body a turn runs with: what its caller pinned, or else the
 * stored value, read now. `undefined` pins nothing, `null` pins "none".
 */
export function pinnedOr<T>(
  pinned: T | null | undefined,
  stored: () => T | undefined
): T | undefined {
  return pinned === undefined ? stored() : (pinned ?? undefined);
}

/** The value `saveMessages` and `continueLastTurn` return for a turn. */
export function toSaveMessagesResult(
  requestId: string,
  outcome: ServerTurnOutcome
): SaveMessagesResult {
  return {
    requestId,
    status: outcome.status,
    ...(outcome.error !== undefined && { error: outcome.error }),
    ...(outcome.reason !== undefined && { reason: outcome.reason })
  };
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
