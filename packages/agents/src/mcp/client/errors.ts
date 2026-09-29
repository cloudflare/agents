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
