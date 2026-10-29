import type {
  LifecycleJobPushOptions,
  LifecycleJobs
} from "../../lifecycle/job-queue";

/**
 * The one durable job the MCP client keeps in the Lifecycle job queue:
 * `auth-expiry:<serverId>` ends an OAuth flow whose authorization link
 * expired before the user completed it, so a dead link does not stay on
 * screen. It makes no network calls.
 *
 * Connections are not retried on a timer. A connect makes a few quick
 * attempts; after that the server is failed until someone reconnects it.
 */

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

/** Payload of an authorization link expiry job. */
export type AuthExpiryJobPayload = {
  readonly serverId: string;
  /** The link this job expires; a newer link makes the job moot. */
  readonly authUrl: string;
  /** When the link was saved, in epoch milliseconds. */
  readonly savedAt: number;
};

/** Parse an authorization expiry job payload read back from the queue. */
export function parseAuthExpiryJobPayload(
  value: unknown
): AuthExpiryJobPayload | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { serverId?: unknown }).serverId !== "string" ||
    typeof (value as { authUrl?: unknown }).authUrl !== "string"
  ) {
    return undefined;
  }
  const { serverId, authUrl, savedAt } = value as {
    serverId: string;
    authUrl: string;
    savedAt?: unknown;
  };
  return {
    serverId,
    authUrl,
    // A job saved before links carried their age counts as old, so its
    // link expires on the next run instead of never.
    savedAt: typeof savedAt === "number" ? savedAt : 0
  };
}

/** The MCP client's link-expiry jobs on the object's Lifecycle job queue. */
export class McpJobs {
  constructor(private readonly queue: () => LifecycleJobs) {}

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

  cancelLinkExpiry(serverId: string): void {
    const id = authExpiryJobId(serverId);
    if (!this.queue().get(id)) return;
    void this.queue()
      .cancel(id)
      .catch((error) => {
        console.warn(`[MCPClientManager] Failed to cancel job ${id}:`, error);
      });
  }

  /** Carry a server's pending link expiry over to its new id. */
  move(oldId: string, newId: string): void {
    const expiry = this.queue().get(authExpiryJobId(oldId));
    const payload = parseAuthExpiryJobPayload(expiry?.payload);
    if (expiry && payload) {
      this.push({
        id: authExpiryJobId(newId),
        fn: AUTH_EXPIRY_JOB,
        time: expiry.time,
        payload: { ...payload, serverId: newId },
        retry: { maxAttempts: 1 }
      });
    }
    this.cancelLinkExpiry(oldId);
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
}

function authExpiryJobId(serverId: string): string {
  return `${AUTH_EXPIRY_JOB}:${serverId}`;
}
