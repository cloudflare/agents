import {
  OAuthError,
  RegistrationRejectedError,
  UnauthorizedError
} from "@modelcontextprotocol/client";

/**
 * Thrown by `MCPClientManager.callTool()` (and `readResource()` /
 * `getPrompt()`) when a request on a ready connection needs the user to
 * authorize again: a `403 insufficient_scope` step-up, or a `401` whose token
 * refresh failed. The MCP SDK has already built a new authorization URL; the
 * manager has moved the connection to `authenticating` and persisted
 * `authUrl`, so sending the user to `authUrl` completes through the normal
 * OAuth callback. Retry the request once the connection is `ready` again.
 *
 * Extends the SDK's `UnauthorizedError`, which these calls threw before, and
 * keeps its `name`, so existing `instanceof UnauthorizedError` and
 * `name === "UnauthorizedError"` checks keep matching. Use
 * `instanceof MCPAuthorizationRequiredError` to read `authUrl`.
 */
export class MCPAuthorizationRequiredError extends UnauthorizedError {
  /** Stable discriminant for this error. */
  readonly _tag = "MCPAuthorizationRequiredError" as const;
  /** The MCP server that needs authorization. */
  readonly serverId: string;
  /** The authorization URL to send the user to; also persisted as `auth_url`. */
  readonly authUrl: string;
  /** The OAuth client id used for the authorization request, when known. */
  readonly clientId?: string;

  /**
   * @param serverId - The MCP server that needs authorization.
   * @param authUrl - The authorization URL the SDK built for the new flow.
   * @param options - The OAuth client id and the original unauthorized error.
   */
  constructor(
    serverId: string,
    authUrl: string,
    options: { clientId?: string; cause?: unknown } = {}
  ) {
    super(
      `MCP server "${serverId}" requires authorization: ${toErrorMessage(options.cause ?? "Unauthorized")}`
    );
    this.cause = options.cause;
    this.serverId = serverId;
    this.authUrl = authUrl;
    this.clientId = options.clientId;
  }
}

/**
 * Thrown by `MCPClientManager.callTool()`, `readResource()` and `getPrompt()`
 * when no connection exists for `serverId`: the id was never registered, the
 * server was removed, or a restore has not created the connection yet.
 */
export class MCPConnectionNotFoundError extends Error {
  /** Stable discriminant for this error. */
  readonly _tag = "MCPConnectionNotFoundError" as const;

  /**
   * @param serverId - The server id that has no connection.
   */
  constructor(readonly serverId: string) {
    super(
      `No MCP connection for server "${serverId}". It may not be registered yet, may have been removed, or may still be restoring.`
    );
    this.name = "MCPConnectionNotFoundError";
  }
}

/** Message of an unknown thrown value. */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as {
    code?: unknown;
    status?: unknown;
    data?: { status?: unknown; cause?: unknown };
  };
  if (typeof record.code === "number") return record.code;
  if (typeof record.status === "number") return record.status;
  if (typeof record.data?.status === "number") return record.data.status;
  return undefined;
}

function getErrorCause(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  return (
    (error as { cause?: unknown; data?: { cause?: unknown } }).cause ??
    (error as { data?: { cause?: unknown } }).data?.cause
  );
}

export function isUnauthorized(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status === 401) return true;
  const cause = getErrorCause(error);
  if (cause && cause !== error && isUnauthorized(cause)) return true;

  const msg = toErrorMessage(error);
  return msg.includes("Unauthorized") || msg.includes("401");
}

/**
 * OAuth error codes a retry can change: the authorization server's own
 * trouble. Every other code (`invalid_target`, `invalid_scope`,
 * `access_denied`, `unauthorized_client`, ...) refuses the request itself.
 * The SDK already recovers `invalid_grant` and `invalid_client` once by
 * starting a fresh authorization, so when they reach us that has failed too.
 */
const RETRYABLE_OAUTH_ERRORS = new Set([
  "server_error",
  "temporarily_unavailable"
]);

/**
 * Whether an error means authorization was refused in a way retrying cannot
 * change: the MCP server answered 403, the authorization server answered
 * with an OAuth error other than a temporary one, or it rejected dynamic
 * client registration with a 4xx other than 429.
 */
export function isAuthorizationRefused(error: unknown, depth = 0): boolean {
  if (depth > 5 || !error || typeof error !== "object") return false;
  if (OAuthError.isInstance(error)) {
    return !RETRYABLE_OAUTH_ERRORS.has(error.code);
  }
  if (RegistrationRejectedError.isInstance(error)) {
    return error.status >= 400 && error.status < 500 && error.status !== 429;
  }
  if (getErrorStatus(error) === 403) return true;
  const cause = getErrorCause(error);
  return cause !== error && isAuthorizationRefused(cause, depth + 1);
}

// MCP SDK change (v1.24.0, commit 6b90e1a):
//   - Old: Error POSTing to endpoint (HTTP 404): Not Found
//   - New: StreamableHTTPError with code: 404 and message Error POSTing to endpoint: Not Found
export function isTransportNotImplemented(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status === 404 || status === 405) return true;
  const cause = getErrorCause(error);
  if (cause && cause !== error && isTransportNotImplemented(cause)) return true;

  const msg = toErrorMessage(error);
  return (
    msg.includes("404") ||
    msg.includes("405") ||
    msg.includes("Error POSTing to endpoint: Not Found") ||
    msg.includes("Not Implemented") ||
    msg.includes("not implemented")
  );
}
