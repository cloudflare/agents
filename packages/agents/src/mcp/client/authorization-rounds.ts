/**
 * The authorization retry limit from the MCP authorization spec
 * (2026-07-28, "Step-Up Authorization Flow"): after a scope challenge the
 * client re-authorizes and retries "no more than a few times", then treats
 * the challenge as a permanent authorization failure, tracking attempts
 * so it does not loop on the same request.
 *
 * A round is one authorization URL the user is sent to. Rounds are counted
 * per requested scope set, and a new round only counts once the previous
 * one completed (its callback exchanged a code) and the server still asked
 * for the same scopes. Several links issued for the same pending ask (for
 * example two tool calls hitting the same step-up at once) are one round.
 */

/** Completed authorization rounds allowed for one scope set. */
export const MAX_AUTHORIZATION_ROUNDS = 3;

/** Rounds further apart than this start counting again. */
export const AUTHORIZATION_ROUNDS_WINDOW_MS = 60 * 60 * 1000;

/** Authorization rounds recorded for one server. */
export type AuthorizationRounds = {
  /** The requested scope set, normalized; empty when no scope was requested. */
  readonly scope: string;
  /** Rounds started for `scope` in the current run. */
  readonly rounds: number;
  /** Whether the latest round's callback exchanged a code. */
  readonly completed: boolean;
  /** When the latest round started, in epoch milliseconds. */
  readonly at: number;
};

/** Whether the next authorization link may be shown. */
export type RoundDecision =
  | { readonly _tag: "start"; readonly rounds: AuthorizationRounds }
  | {
      readonly _tag: "exhausted";
      readonly rounds: number;
      readonly scope: string;
    };

/**
 * The requested scope set of an authorization URL: the `scope` parameter's
 * tokens, deduplicated and sorted, or an empty string when absent.
 */
export function requestedScope(authUrl: string): string {
  let scope: string | null;
  try {
    scope = new URL(authUrl).searchParams.get("scope");
  } catch {
    return "";
  }
  if (!scope) return "";
  return [...new Set(scope.split(/\s+/).filter(Boolean))].sort().join(" ");
}

/**
 * Decide whether a new authorization link may be shown.
 *
 * @param previous - The server's recorded rounds, when any.
 * @param scope - The requested scope set of the new link.
 * @param now - The current time in epoch milliseconds.
 * @returns The rounds to record, or that the limit is reached.
 */
export function startRound(
  previous: AuthorizationRounds | undefined,
  scope: string,
  now: number
): RoundDecision {
  if (
    !previous ||
    previous.scope !== scope ||
    now - previous.at > AUTHORIZATION_ROUNDS_WINDOW_MS
  ) {
    return {
      _tag: "start",
      rounds: { scope, rounds: 1, completed: false, at: now }
    };
  }
  if (!previous.completed) {
    // Another link for the round still waiting on the user.
    return { _tag: "start", rounds: { ...previous, at: now } };
  }
  const rounds = previous.rounds + 1;
  if (rounds > MAX_AUTHORIZATION_ROUNDS) {
    return { _tag: "exhausted", rounds: previous.rounds, scope };
  }
  return {
    _tag: "start",
    rounds: { scope, rounds, completed: false, at: now }
  };
}

/** Record that the latest round's callback exchanged a code. */
export function completeRound(
  previous: AuthorizationRounds | undefined
): AuthorizationRounds | undefined {
  return previous ? { ...previous, completed: true } : undefined;
}

/** Parse recorded rounds read back from storage. */
export function parseAuthorizationRounds(
  value: unknown
): AuthorizationRounds | undefined {
  if (
    !isRecord(value) ||
    typeof value.scope !== "string" ||
    typeof value.rounds !== "number" ||
    typeof value.completed !== "boolean" ||
    typeof value.at !== "number"
  ) {
    return undefined;
  }
  return {
    scope: value.scope,
    rounds: value.rounds,
    completed: value.completed,
    at: value.at
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Message for a server that hit the limit. */
export function authorizationExhaustedMessage(
  rounds: number,
  scope: string
): string {
  const scopes = scope ? ` for scope "${scope}"` : "";
  return `The server still requires authorization${scopes} after ${rounds} completed authorizations. Stopped to avoid an authorization loop; reconnect the server to try again.`;
}
