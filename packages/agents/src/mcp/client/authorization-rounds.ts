/**
 * The authorization retry limit from the MCP authorization spec
 * (2026-07-28, "Step-Up Authorization Flow"): after a scope challenge the
 * client re-authorizes and retries "no more than a few times", then treats
 * the challenge as a permanent authorization failure, tracking attempts
 * so it does not loop on the same request.
 *
 * A round is one authorization URL the user is sent to. Rounds are counted
 * separately for each requested scope set, so challenges that alternate
 * between scope sets each use up their own budget. A new round for a scope
 * set only counts once its previous round completed (its callback exchanged
 * a code) and the server asked for the same scopes again. Several links
 * issued for one pending ask (for example two tool calls hitting the same
 * step-up at once) are one round.
 */

/** Completed authorization rounds allowed for one scope set. */
const MAX_AUTHORIZATION_ROUNDS = 3;

/** A scope set's rounds are forgotten this long after its latest round. */
const AUTHORIZATION_ROUNDS_WINDOW_MS = 60 * 60 * 1000;

/** Rounds recorded for one requested scope set. */
type ScopeRounds = {
  /** Rounds started for this scope set within the window. */
  readonly rounds: number;
  /** Whether this scope set's latest round's callback exchanged a code. */
  readonly completed: boolean;
  /** When this scope set's latest round started, in epoch milliseconds. */
  readonly at: number;
};

/** Authorization rounds recorded for one server. */
type AuthorizationRounds = {
  /** The scope set of the round started most recently. */
  readonly latest: string;
  /** Rounds per normalized scope set; `""` when no scope was requested. */
  readonly byScope: Readonly<Record<string, ScopeRounds>>;
};

/** Whether the next authorization link may be shown. */
type RoundDecision =
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
  const byScope = live(previous?.byScope ?? {}, now);
  const current = entryFor(byScope, scope);
  let next: ScopeRounds;
  if (!current) {
    next = { rounds: 1, completed: false, at: now };
  } else if (!current.completed) {
    // Another link for the round still waiting on the user.
    next = { ...current, at: now };
  } else if (current.rounds + 1 > MAX_AUTHORIZATION_ROUNDS) {
    return { _tag: "exhausted", rounds: current.rounds, scope };
  } else {
    next = { rounds: current.rounds + 1, completed: false, at: now };
  }
  return {
    _tag: "start",
    rounds: { latest: scope, byScope: { ...byScope, [scope]: next } }
  };
}

/** Record that the latest round's callback exchanged a code. */
export function completeRound(
  previous: AuthorizationRounds | undefined
): AuthorizationRounds | undefined {
  if (!previous) return undefined;
  const current = entryFor(previous.byScope, previous.latest);
  if (!current) return previous;
  return {
    latest: previous.latest,
    byScope: {
      ...previous.byScope,
      [previous.latest]: { ...current, completed: true }
    }
  };
}

/** Parse recorded rounds read back from storage. */
export function parseAuthorizationRounds(
  value: unknown
): AuthorizationRounds | undefined {
  if (
    !isRecord(value) ||
    typeof value.latest !== "string" ||
    !isRecord(value.byScope)
  ) {
    return undefined;
  }
  // Object.fromEntries defines own properties, so scope names such as
  // `__proto__` or `constructor` are stored like any other.
  const byScope = Object.fromEntries(
    Object.entries(value.byScope).flatMap(([scope, entry]) =>
      isRecord(entry) &&
      typeof entry.rounds === "number" &&
      typeof entry.completed === "boolean" &&
      typeof entry.at === "number"
        ? [
            [
              scope,
              {
                rounds: entry.rounds,
                completed: entry.completed,
                at: entry.at
              }
            ] as const
          ]
        : []
    )
  );
  return { latest: value.latest, byScope };
}

/** Message for a server that hit the limit. */
export function authorizationExhaustedMessage(
  rounds: number,
  scope: string
): string {
  const scopes = scope ? ` for scope "${scope}"` : "";
  return `The server still requires authorization${scopes} after ${rounds} completed authorizations. Stopped to avoid an authorization loop; reconnect the server to try again.`;
}

/** A scope set's own entry; never an inherited `Object` member. */
function entryFor(
  byScope: Readonly<Record<string, ScopeRounds>>,
  scope: string
): ScopeRounds | undefined {
  return Object.hasOwn(byScope, scope) ? byScope[scope] : undefined;
}

/** Scope sets whose latest round is still inside the window. */
function live(
  byScope: Readonly<Record<string, ScopeRounds>>,
  now: number
): Record<string, ScopeRounds> {
  return Object.fromEntries(
    Object.entries(byScope).filter(
      ([, entry]) => now - entry.at <= AUTHORIZATION_ROUNDS_WINDOW_MS
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
