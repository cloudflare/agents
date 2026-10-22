import { UnauthorizedError } from "@modelcontextprotocol/client";

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
  readonly serverId: string;
  readonly authUrl: string;
  readonly clientId?: string;

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
