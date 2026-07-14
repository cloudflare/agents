export function internalErrorResponse(
  id: string | number | null = null
): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal server error" },
      id
    },
    { status: 500 }
  );
}

export function requestIdFromParsedBody(body: unknown): string | number | null {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    !("method" in body) ||
    typeof body.method !== "string" ||
    !("id" in body)
  ) {
    return null;
  }
  return typeof body.id === "string" || typeof body.id === "number"
    ? body.id
    : null;
}

export function reportHandlerError(
  onerror: ((error: Error) => void) | undefined,
  error: unknown
): void {
  try {
    onerror?.(error instanceof Error ? error : new Error(String(error)));
  } catch {
    // Error reporting must not change the response.
  }
}
