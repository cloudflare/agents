import type { Think } from "../../app/think.js";
import { relayTurn as relayTurnOnLog, type RelayCallback } from "../../domain/events/relay.js";

export type { RelayCallback } from "../../domain/events/relay.js";

/**
 * relayTurn (audit 25 §5), adapter-facing form.
 *
 * The audit sketches this as the one place `Think.chat()`'s child-relay
 * wiring lives: `Think.chat()` would import it from here. That's not
 * possible under the layering rule enforced by
 * `src/app/no-transport.test.ts`'s sibling acceptance test (app/ may not
 * import adapters/) — and more concretely, `app/think.ts` has no `Think`
 * instance to hand this module until *after* construction, whereas
 * `chat()` needs to subscribe before its own turn starts.
 *
 * Resolution: the log-level primitive lives in `domain/events/relay.ts`
 * (`relayTurn(log, requestId, callback, fromOffset?)`), with no adapter or
 * app dependency either way; `Think.chat()` calls it directly. This module
 * re-exports the same primitive in the adapter-facing shape the audit
 * describes — taking the *agent* rather than a bare log — for any adapter
 * that wants to relay a turn it did not itself start (e.g. reattaching to
 * an already-in-flight child turn). Unlike `Think.chat()`'s own use (which
 * subscribes before the turn starts and so only ever needs "live"), such a
 * caller replays from the turn's `startOffset` when it's the active turn,
 * so it catches up on chunks it missed.
 */
export function relayTurn(
  agent: Pick<Think, "events" | "activeTurn">,
  requestId: string,
  callback: RelayCallback,
): () => void {
  const active = agent.activeTurn();
  const fromOffset = active !== null && active.requestId === requestId ? active.startOffset : "live";
  return relayTurnOnLog(agent.events(), requestId, callback, fromOffset);
}
