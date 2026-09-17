/**
 * Asks: correlated durable questions a transition raises and anyone answers
 * later with only the ask id.
 *
 * The answer type travels with the KIND rather than with the run, which is
 * what makes `tasks.answer(askId, Approve, decision)` type-check from a file
 * that has never heard of the definition — and what makes an approval
 * arriving as a WebSocket frame, on an isolate holding nothing in memory,
 * routable and type-safe at once.
 */

import type { AskKind } from "./types";

/**
 * Declare one ask kind, with its question payload and its answer type.
 *
 * ```ts
 * const Approve = defineAsk<{ toolCallId: string }, Decision>("tool-approval");
 * ```
 *
 * @param name - Stable name persisted with every ask of this kind, and what
 * a typed `answer()` checks the id against.
 *
 * @experimental The API surface may change before stabilizing.
 */
export function defineAsk<Payload, Answer>(
  name: string
): AskKind<Payload, Answer> {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Ask kind names must be non-empty strings");
  }
  return { name };
}
