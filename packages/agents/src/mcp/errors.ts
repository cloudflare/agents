export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorCode(error: unknown): number | undefined {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "number"
  ) {
    return (error as { code: number }).code;
  }
  return undefined;
}

export function isUnauthorized(error: unknown): boolean {
  const code = getErrorCode(error);
  if (code === 401) return true;

  const msg = toErrorMessage(error);
  return msg.includes("Unauthorized") || msg.includes("401");
}

// MCP SDK change (v1.24.0, commit 6b90e1a):
//   - Old: Error POSTing to endpoint (HTTP 404): Not Found
//   - New: StreamableHTTPError with code: 404 and message Error POSTing to endpoint: Not Found
export function isTransportNotImplemented(error: unknown): boolean {
  const code = getErrorCode(error);
  if (code === 404 || code === 405) return true;

  const msg = toErrorMessage(error);
  return (
    msg.includes("404") ||
    msg.includes("405") ||
    msg.includes("Not Implemented") ||
    msg.includes("not implemented")
  );
}
