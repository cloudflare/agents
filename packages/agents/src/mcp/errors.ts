export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isUnauthorized(error: unknown): boolean {
  const msg = toErrorMessage(error);
  return msg.includes("Unauthorized") || msg.includes("401");
}

export function isTransportNotImplemented(error: unknown): boolean {
  const msg = toErrorMessage(error);
  // Treat common "not implemented" surfaces as transport not supported
  return (
    msg.includes("404") ||
    msg.includes("405") ||
    msg.includes("Not Implemented") ||
    msg.includes("not implemented")
  );
}
