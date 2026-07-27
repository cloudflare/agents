/**
 * The turn state machine — every state and every legal transition, in one
 * place. The engine moves turns only through its `moveTurn` helper, which
 * pairs this table's check with the store's compare-and-set.
 *
 * | State       | Meaning                            | Crash here ⇒              |
 * | ----------- | ---------------------------------- | ------------------------- |
 * | `accepted`  | admitted, no committed output      | safe to re-run             |
 * | `streaming` | journal contains partial output    | resume exactly (connector  |
 * |             |                                    | capability) or interrupt   |
 * | `waiting`   | paused on a human interaction      | no-op — wait is durable    |
 * | `settled`   | terminal outcome recorded          | retry is a no-op           |
 */

export const TURN_STATES = [
  "accepted",
  "streaming",
  "waiting",
  "settled"
] as const;

export type TurnState = (typeof TURN_STATES)[number];

const LEGAL_TRANSITIONS: Record<TurnState, readonly TurnState[]> = {
  // First committed output, pause, or failure-before-output.
  accepted: ["streaming", "waiting", "settled"],
  // Pause mid-stream, or the stream ends.
  streaming: ["waiting", "settled"],
  // The completion joins via an ordinary inbound event, or the wait is
  // cancelled (interaction expiry rides this edge later too).
  waiting: ["accepted", "settled"],
  // Terminal.
  settled: []
};

export function isTurnState(value: unknown): value is TurnState {
  return TURN_STATES.includes(value as TurnState);
}

export class IllegalTurnTransitionError extends Error {
  constructor(turnId: string, from: TurnState, to: TurnState) {
    super(`Turn ${turnId} cannot move from ${from} to ${to}`);
    this.name = "IllegalTurnTransitionError";
  }
}

/** Throws unless `from → to` is a legal transition for this turn. */
export function assertTransition(
  turnId: string,
  from: TurnState,
  to: TurnState
): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new IllegalTurnTransitionError(turnId, from, to);
  }
}
