/**
 * One chat turn a caller starts over RPC and follows through a callback
 * (`Think.chat()`), as the turn core runs it. The counterpart of
 * `ChatTurns.runClientRequest` for a caller that is not a WebSocket client:
 * there is no concurrency policy and no connection to park, but the same
 * rules hold for a cancel and for a chat reset.
 *
 * @internal Sibling-package support for `@cloudflare/think`, not a public API.
 */

import type { AbortRegistry } from "./abort-registry";
import type { TurnQueue } from "./turn-queue";

/**
 * The steps of an RPC chat request the host supplies. The core owns their
 * order.
 */
export interface RpcChatRequest {
  requestId: string;
  /** The caller's own signal. Aborting it cancels the request. */
  signal?: AbortSignal;
  /**
   * Tell the caller the request id, so it can cancel the request by id. Runs
   * after the request is accepted and before it is queued.
   */
  onStart?(): void | Promise<void>;
  /**
   * Admit the turn through the host's own queue wrapper (tracing, hooks,
   * keep-alive). It must enqueue `turn` on the core's queue under
   * `generation` and report whether the turn ran or was skipped as stale.
   */
  enqueue(
    turn: () => Promise<void>,
    generation: number
  ): Promise<"completed" | "stale">;
  /**
   * Run the turn: store the caller's message, call the model, stream the
   * reply to the caller. `signal` aborts when the request is cancelled or the
   * chat is reset.
   *
   * @param context.isCurrent - `false` once the chat was reset since the
   *   request was accepted. Check it after each await that comes before a
   *   write to the transcript.
   */
  run(
    signal: AbortSignal,
    context: { isCurrent: () => boolean }
  ): Promise<void>;
  /**
   * The chat was reset (cleared) after the request was accepted: while it
   * waited in the queue, or while its turn ran. The caller did not ask for
   * that, so tell it the request ended without an answer.
   */
  onReset(): void | Promise<void>;
  /**
   * The request was cancelled before its turn started. Nothing was stored
   * and the model was never called.
   */
  onCancelledBeforeStart?(): void | Promise<void>;
}

/**
 * Run one RPC chat request, start to finish:
 *
 * 1. Accept it: capture the queue generation, create its abort controller
 *    and link the caller's signal, so a cancel or a reset that arrives at
 *    any later point, including during `onStart` and while the request waits
 *    in the queue, is not lost.
 * 2. Tell the caller the request id, then queue the turn under the captured
 *    generation.
 * 3. At the front of the queue: a turn the chat was reset under is skipped,
 *    a request cancelled meanwhile ends without storing its message or
 *    calling the model, otherwise the turn runs.
 * 4. If the chat was reset at any point after acceptance, report it.
 * 5. Whatever happened, unlink the caller's signal and drop the controller.
 */
export async function runRpcRequest(
  core: { queue: TurnQueue; aborts: AbortRegistry },
  request: RpcChatRequest
): Promise<void> {
  const { requestId } = request;
  const generation = core.queue.generation;
  const isCurrent = () => core.queue.generation === generation;
  // Held here, not looked up later: a reset empties the registry, and the
  // turn must still see the abort that came with it.
  const signal =
    core.aborts.getSignal(requestId) ?? new AbortController().signal;
  const detachExternal = core.aborts.linkExternal(requestId, request.signal);
  try {
    await request.onStart?.();
    const outcome = await request.enqueue(async () => {
      if (signal.aborted) {
        await request.onCancelledBeforeStart?.();
        return;
      }
      await request.run(signal, { isCurrent });
    }, generation);
    if (outcome === "stale" || !isCurrent()) await request.onReset();
  } finally {
    detachExternal();
    core.aborts.remove(requestId);
  }
}
