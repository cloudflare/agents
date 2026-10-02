/**
 * Client-side model fallback for pi-ai streams.
 *
 * A leg is abandoned when its stream terminates with an `error` event before
 * it produced any content; the next model is tried with the same context and
 * options. Once a leg has emitted content it is committed to, and a later
 * error propagates. `start` and the block starts that may follow it carry no
 * content, so they are held back until a leg proves itself.
 */

import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model,
  createAssistantMessageEventStream
} from "@earendil-works/pi-ai";
import { failStream } from "../errors";
import { jsonDetails, startMessage } from "../wires/shared";

/** One model to try, with the stream that dispatches it. */
export interface FallbackLeg {
  model: Model<Api>;
  start(): AssistantMessageEventStream;
}

/** A leg that was tried and failed before producing output. */
export interface FallbackAttempt {
  model: string;
  errorMessage: string | undefined;
}

/** Diagnostic type under which abandoned legs are recorded. */
export const FALLBACK_DIAGNOSTIC = "cloudflare-fallback";

/**
 * Events that announce output without carrying any. A leg that emits only
 * these and then fails has produced nothing, so they are held back with
 * `start` until the leg proves itself.
 */
const PREAMBLE_EVENTS = new Set<AssistantMessageEvent["type"]>([
  "start",
  "text_start",
  "thinking_start",
  "toolcall_start"
]);

function isAbandonable(event: AssistantMessageEvent): boolean {
  return event.type === "error" && event.reason === "error";
}

/**
 * Runs legs in order, committing to the first one that produces output.
 *
 * The returned stream always ends. A leg that throws, a stream that rejects,
 * a leg that starts answering and then ends without a `done` or `error`
 * event, and a last leg that ends without producing anything all end it
 * with an `error` event, so a caller awaiting the result is never left
 * waiting.
 */
export function streamWithFallback(
  legs: FallbackLeg[],
  signal?: AbortSignal
): AssistantMessageEventStream {
  const first = legs[0];
  if (first === undefined) {
    throw new Error("streamWithFallback needs at least one leg.");
  }
  const outer = createAssistantMessageEventStream();
  const attempts: FallbackAttempt[] = [];
  let ended = false;
  const end = (message: AssistantMessage): void => {
    ended = true;
    outer.end(message);
  };
  const recordAttempts = (message: AssistantMessage): void => {
    message.diagnostics = [
      ...(message.diagnostics ?? []),
      {
        details: jsonDetails({ attempts }),
        timestamp: Date.now(),
        type: FALLBACK_DIAGNOSTIC
      }
    ];
  };

  void (async () => {
    let current = first;
    let lastError: AssistantMessage | undefined;
    try {
      for (const [index, leg] of legs.entries()) {
        current = leg;
        const isLast = index === legs.length - 1;
        const inner = leg.start();
        let pending: AssistantMessageEvent[] = [];
        let committed = false;
        let finished = false;
        for await (const event of inner) {
          if (!committed && PREAMBLE_EVENTS.has(event.type)) {
            pending.push(event);
            continue;
          }
          if (!committed) {
            if (event.type === "error" && isAbandonable(event) && !isLast) {
              attempts.push({
                errorMessage: event.error.errorMessage,
                model: leg.model.id
              });
              lastError = event.error;
              break;
            }
            committed = true;
            for (const held of pending) outer.push(held);
            pending = [];
          }
          if (
            (event.type === "done" || event.type === "error") &&
            attempts.length > 0
          ) {
            recordAttempts(event.type === "done" ? event.message : event.error);
          }
          outer.push(event);
          if (event.type === "done" || event.type === "error") finished = true;
        }
        // A terminal event resolves the leg's result. pi's protocol ends every
        // stream with one, and a leg that ends without it has no result to
        // wait for.
        if (finished) {
          end(await inner.result());
          return;
        }
        if (committed) {
          throw new Error(
            `${leg.model.id} ended its stream without a done or error event.`
          );
        }
      }
      // Every leg was abandoned; surface the last error as the result.
      if (lastError !== undefined) {
        recordAttempts(lastError);
        outer.push({ error: lastError, reason: "error", type: "error" });
        end(lastError);
        return;
      }
      throw new Error(`${current.model.id} ended its stream without output.`);
    } catch (error) {
      if (ended) return;
      const message = startMessage(current.model);
      if (attempts.length > 0) recordAttempts(message);
      ended = true;
      failStream(outer, message, error, signal);
    }
  })();

  return outer;
}
