import type {
  LifecycleJob,
  LifecycleJobPushOptions,
  LifecycleJobs
} from "../../lifecycle/job-queue";

/**
 * The durable work the MCP client keeps in the Lifecycle job queue:
 *
 * - `connect:<serverId>`: bring a server back after a failed connection
 *   attempt, on a backoff that survives eviction, until it connects, needs
 *   authorization, or the policy gives up.
 * - `auth-expiry:<serverId>`: end an OAuth flow whose authorization link
 *   expired before the user completed it.
 *
 * This file names, schedules, moves and cancels those jobs. It decides
 * nothing about servers: the controllers call it, and the manager's
 * `onJob` hands due jobs back to them.
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

/**
 * The longest a link stays pending, even when a custom provider would still
 * redeem its `state`. Past this the flow is recorded as expired, so a link
 * nobody completes does not wake the object every ten minutes forever.
 */
export const AUTHORIZATION_LINK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
type ReconnectPolicy = {
  readonly delaysMs: readonly number[];
  readonly giveUpAfterMs: number;
};

/** Default durable reconnect limits. */
const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
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

/** Payload of a durable reconnect job. */
type ConnectJobPayload = {
  readonly serverId: string;
  /** Failed attempts so far, counting the one that scheduled this job. */
  readonly attempt: number;
  /** When the first attempt of this run of failures failed, in epoch ms. */
  readonly firstFailureAt: number;
  /** When the latest attempt failed, in epoch ms. */
  readonly failedAt: number;
  /** The latest attempt's error, shown while the next attempt waits. */
  readonly error: string;
};

/** Payload of an authorization link expiry job. */
export type AuthExpiryJobPayload = {
  readonly serverId: string;
  /** The link this job expires; a newer link makes the job moot. */
  readonly authUrl: string;
  /** When the link was saved, in epoch milliseconds. */
  readonly savedAt: number;
};

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
    firstFailureAt: value.firstFailureAt,
    failedAt:
      typeof value.failedAt === "number"
        ? value.failedAt
        : value.firstFailureAt,
    error: typeof value.error === "string" ? value.error : "Connection failed"
  };
}

/** Parse an authorization expiry job payload read back from the queue. */
export function parseAuthExpiryJobPayload(
  value: unknown
): AuthExpiryJobPayload | undefined {
  if (
    !isRecord(value) ||
    typeof value.serverId !== "string" ||
    typeof value.authUrl !== "string" ||
    typeof value.savedAt !== "number"
  ) {
    return undefined;
  }
  return {
    serverId: value.serverId,
    authUrl: value.authUrl,
    savedAt: value.savedAt
  };
}

/** What to do after a failed connection attempt. */
type ReconnectDecision =
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
 * @param error - The failed attempt's error.
 * @param now - The current time in epoch milliseconds.
 * @returns When to try again, or that the policy gives up.
 */
function nextReconnect(
  policy: ReconnectPolicy,
  previous: ConnectJobPayload | undefined,
  serverId: string,
  error: string,
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
    payload: { serverId, attempt, firstFailureAt, failedAt: now, error }
  };
}

/** The MCP client's jobs on the object's Lifecycle job queue. */
export class McpJobs {
  constructor(
    private readonly queue: () => LifecycleJobs,
    private readonly policy: ReconnectPolicy
  ) {}

  /** The reconnect waiting for a server, when one is scheduled. */
  pendingReconnect(serverId: string): ConnectJobPayload | undefined {
    return parseConnectJobPayload(
      this.queue().get(connectJobId(serverId))?.payload
    );
  }

  /**
   * Whether a failure at `failedAt` is too recent to try again on request
   * from `addMcpServer()`: sooner than the first backoff step.
   */
  tooSoonToRetry(failedAt: number | undefined): boolean {
    return (
      failedAt !== undefined && Date.now() - failedAt < this.policy.delaysMs[0]
    );
  }

  /** Whether `job` was moved to a later time after it fired. */
  isRescheduled(job: LifecycleJob): boolean {
    const current = this.queue().get(job.id);
    return current !== undefined && current.time > Date.now();
  }

  /**
   * Schedule the next reconnect after a failed attempt.
   * @returns How many attempts were made when the policy gives up instead.
   */
  scheduleReconnect(
    serverId: string,
    error: string
  ): { readonly gaveUpAfter?: number } {
    const decision = nextReconnect(
      this.policy,
      this.pendingReconnect(serverId),
      serverId,
      error,
      Date.now()
    );
    if (decision._tag === "give-up") return { gaveUpAfter: decision.attempts };
    this.push({
      id: connectJobId(serverId),
      fn: CONNECT_JOB,
      time: decision.time,
      payload: decision.payload,
      retry: { maxAttempts: 1 },
      // One attempt can wait out a connect and a discovery timeout.
      hungTimeoutSeconds: 120
    });
    return {};
  }

  /** Expire a server's authorization link once its lifetime has passed. */
  armLinkExpiry(serverId: string, authUrl: string): void {
    this.push({
      id: authExpiryJobId(serverId),
      fn: AUTH_EXPIRY_JOB,
      time: Date.now() + AUTHORIZATION_LINK_TTL_MS,
      payload: {
        serverId,
        authUrl,
        savedAt: Date.now()
      } satisfies AuthExpiryJobPayload,
      retry: { maxAttempts: 1 }
    });
  }

  /** Whether a server's link has an expiry scheduled. */
  hasLinkExpiry(serverId: string): boolean {
    return this.queue().get(authExpiryJobId(serverId)) !== undefined;
  }

  cancelReconnect(serverId: string): void {
    this.cancel(connectJobId(serverId));
  }

  cancelLinkExpiry(serverId: string): void {
    this.cancel(authExpiryJobId(serverId));
  }

  /** Cancel both of a server's jobs. */
  cancelAll(serverId: string): void {
    this.cancelReconnect(serverId);
    this.cancelLinkExpiry(serverId);
  }

  /** Carry a server's pending jobs over to its new id. */
  move(oldId: string, newId: string): void {
    const connect = this.queue().get(connectJobId(oldId));
    const connectPayload = parseConnectJobPayload(connect?.payload);
    if (connect && connectPayload) {
      this.push({
        id: connectJobId(newId),
        fn: CONNECT_JOB,
        time: connect.time,
        payload: { ...connectPayload, serverId: newId },
        retry: { maxAttempts: 1 },
        hungTimeoutSeconds: 120
      });
    }
    const expiry = this.queue().get(authExpiryJobId(oldId));
    const expiryPayload = parseAuthExpiryJobPayload(expiry?.payload);
    if (expiry && expiryPayload) {
      this.push({
        id: authExpiryJobId(newId),
        fn: AUTH_EXPIRY_JOB,
        time: expiry.time,
        payload: { ...expiryPayload, serverId: newId },
        retry: { maxAttempts: 1 }
      });
    }
    this.cancelAll(oldId);
  }

  /** Push a job, logging instead of throwing. */
  private push(options: LifecycleJobPushOptions): void {
    void this.queue()
      .push(options)
      .catch((error) => {
        console.warn(
          `[MCPClientManager] Failed to schedule job ${options.id}:`,
          error
        );
      });
  }

  /** Cancel a job when it exists. */
  private cancel(id: string): void {
    if (!this.queue().get(id)) return;
    void this.queue()
      .cancel(id)
      .catch((error) => {
        console.warn(`[MCPClientManager] Failed to cancel job ${id}:`, error);
      });
  }
}

function connectJobId(serverId: string): string {
  return `${CONNECT_JOB}:${serverId}`;
}

function authExpiryJobId(serverId: string): string {
  return `${AUTH_EXPIRY_JOB}:${serverId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
