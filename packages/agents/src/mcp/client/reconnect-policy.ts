/**
 * The durable work the MCP client manager keeps in the Lifecycle job queue,
 * and the policy that schedules it:
 *
 * - `connect:<serverId>`: bring a server back after a failed connection
 *   attempt, on a backoff that survives eviction, until it connects, needs
 *   authorization, or the policy gives up.
 * - `auth-expiry:<serverId>`: end an OAuth flow whose authorization link
 *   expired before the user completed it.
 *
 * Everything here is pure: job ids, payload parsing, and backoff decisions.
 */

/** Job function name for durable reconnect attempts. */
export const CONNECT_JOB = "connect";

/** Job function name for authorization link expiry. */
export const AUTH_EXPIRY_JOB = "auth-expiry";

/**
 * How long an authorization link stays valid. Matches the OAuth state
 * lifetime of `DurableObjectOAuthClientProvider`.
 */
export const AUTHORIZATION_LINK_TTL_MS = 10 * 60 * 1000;

/** Message shown on a server whose authorization link expired unused. */
export const AUTHORIZATION_EXPIRED_MESSAGE =
  "Authorization expired before it was completed. Reconnect the server to start again.";

/** Backoff and give-up limits for durable reconnects. */
export type MCPReconnectOptions = {
  /**
   * Delay before each durable reconnect attempt, in milliseconds. The last
   * entry repeats. Default: 30s, 1m, 2m, 5m, 10m, then every 30m.
   */
  readonly delaysMs?: readonly number[];
  /**
   * Stop reconnecting this long after the first failed attempt, in
   * milliseconds, and mark the server failed. Default: 24 hours.
   */
  readonly giveUpAfterMs?: number;
};

/** Resolved durable reconnect limits. */
export type ReconnectPolicy = {
  readonly delaysMs: readonly number[];
  readonly giveUpAfterMs: number;
};

/** Default durable reconnect limits. */
export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  delaysMs: [30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000],
  giveUpAfterMs: 24 * 60 * 60 * 1000
};

/** Resolve caller options against the defaults. */
export function makeReconnectPolicy(
  options: MCPReconnectOptions | undefined
): ReconnectPolicy {
  const delaysMs =
    options?.delaysMs && options.delaysMs.length > 0
      ? options.delaysMs
      : DEFAULT_RECONNECT_POLICY.delaysMs;
  return {
    delaysMs,
    giveUpAfterMs:
      options?.giveUpAfterMs ?? DEFAULT_RECONNECT_POLICY.giveUpAfterMs
  };
}

/** Job id of a server's durable reconnect. */
export function connectJobId(serverId: string): string {
  return `${CONNECT_JOB}:${serverId}`;
}

/** Job id of a server's authorization link expiry. */
export function authExpiryJobId(serverId: string): string {
  return `${AUTH_EXPIRY_JOB}:${serverId}`;
}

/** Payload of a durable reconnect job. */
export type ConnectJobPayload = {
  readonly serverId: string;
  /** Failed attempts so far, counting the one that scheduled this job. */
  readonly attempt: number;
  /** When the first attempt of this run of failures failed, in epoch ms. */
  readonly firstFailureAt: number;
};

/** Payload of an authorization link expiry job. */
export type AuthExpiryJobPayload = {
  readonly serverId: string;
  /** The link this job expires; a newer link makes the job moot. */
  readonly authUrl: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parse a reconnect job payload read back from the queue. */
export function parseConnectJobPayload(
  value: unknown
): ConnectJobPayload | undefined {
  if (
    !isRecord(value) ||
    typeof value.serverId !== "string" ||
    typeof value.attempt !== "number" ||
    typeof value.firstFailureAt !== "number"
  ) {
    return undefined;
  }
  return {
    serverId: value.serverId,
    attempt: value.attempt,
    firstFailureAt: value.firstFailureAt
  };
}

/** Parse an authorization expiry job payload read back from the queue. */
export function parseAuthExpiryJobPayload(
  value: unknown
): AuthExpiryJobPayload | undefined {
  if (
    !isRecord(value) ||
    typeof value.serverId !== "string" ||
    typeof value.authUrl !== "string"
  ) {
    return undefined;
  }
  return { serverId: value.serverId, authUrl: value.authUrl };
}

/** What to do after a failed connection attempt. */
export type ReconnectDecision =
  | {
      readonly _tag: "retry";
      readonly time: number;
      readonly payload: ConnectJobPayload;
    }
  | { readonly _tag: "give-up"; readonly attempts: number };

/**
 * Decide the next durable reconnect after a failed attempt.
 *
 * @param policy - Backoff and give-up limits.
 * @param previous - The pending reconnect job's payload, when one exists.
 * @param serverId - The server that failed to connect.
 * @param now - The current time in epoch milliseconds.
 * @returns When to try again, or that the policy gives up.
 */
export function nextReconnect(
  policy: ReconnectPolicy,
  previous: ConnectJobPayload | undefined,
  serverId: string,
  now: number
): ReconnectDecision {
  const attempt = (previous?.attempt ?? 0) + 1;
  const firstFailureAt = previous?.firstFailureAt ?? now;
  if (now - firstFailureAt >= policy.giveUpAfterMs) {
    return { _tag: "give-up", attempts: attempt };
  }
  const delays = policy.delaysMs;
  const delay = delays[Math.min(attempt, delays.length) - 1] ?? 0;
  return {
    _tag: "retry",
    time: now + delay,
    payload: { serverId, attempt, firstFailureAt }
  };
}
