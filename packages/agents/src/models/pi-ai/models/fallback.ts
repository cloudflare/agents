/**
 * Client-side model fallback for pi-ai streams.
 *
 * A leg is abandoned when its stream terminates with an `error` event before
 * it produced any content; the next model is tried with the same context and
 * options. Once a leg has emitted content it is committed to, and a later
 * error propagates. pi-ai's protocol requires `start` before any update, so
 * `start` is held back until a leg proves itself.
 */

import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream
} from "@earendil-works/pi-ai";

/** One model to try, with the stream that dispatches it. */
export interface FallbackLeg {
  modelId: string;
  start(): AssistantMessageEventStream;
}

/** A leg that was tried and failed before producing output. */
export interface FallbackAttempt {
  model: string;
  errorMessage: string | undefined;
}

/** Diagnostic type under which abandoned legs are recorded. */
export const FALLBACK_DIAGNOSTIC = "cloudflare-fallback";

function isAbandonable(event: AssistantMessageEvent): boolean {
  return event.type === "error" && event.reason === "error";
}

/** Runs legs in order, committing to the first one that produces output. */
export function streamWithFallback(
  legs: FallbackLeg[]
): AssistantMessageEventStream {
  if (legs.length === 0) {
    throw new Error("streamWithFallback needs at least one leg.");
  }
  const outer = createAssistantMessageEventStream();
  const attempts: FallbackAttempt[] = [];

  void (async () => {
    let lastError: AssistantMessage | undefined;
    for (const [index, leg] of legs.entries()) {
      const isLast = index === legs.length - 1;
      const inner = leg.start();
      let pendingStart: AssistantMessageEvent | undefined;
      let committed = false;
      let finished = false;
      for await (const event of inner) {
        if (event.type === "start" && !committed) {
          pendingStart = event;
          continue;
        }
        if (!committed) {
          if (event.type === "error" && isAbandonable(event) && !isLast) {
            attempts.push({
              errorMessage: event.error.errorMessage,
              model: leg.modelId
            });
            lastError = event.error;
            break;
          }
          committed = true;
          if (pendingStart !== undefined) outer.push(pendingStart);
          pendingStart = undefined;
        }
        if (
          (event.type === "done" || event.type === "error") &&
          attempts.length > 0
        ) {
          const message = event.type === "done" ? event.message : event.error;
          message.diagnostics = [
            ...(message.diagnostics ?? []),
            {
              details: { attempts },
              timestamp: Date.now(),
              type: FALLBACK_DIAGNOSTIC
            }
          ];
        }
        outer.push(event);
        if (event.type === "done" || event.type === "error") finished = true;
      }
      if (committed || finished) {
        outer.end(await inner.result());
        return;
      }
    }
    // Every leg was abandoned; surface the last error as the result.
    if (lastError !== undefined) {
      lastError.diagnostics = [
        ...(lastError.diagnostics ?? []),
        {
          details: { attempts },
          timestamp: Date.now(),
          type: FALLBACK_DIAGNOSTIC
        }
      ];
      outer.push({ error: lastError, reason: "error", type: "error" });
      outer.end(lastError);
    }
  })();

  return outer;
}
