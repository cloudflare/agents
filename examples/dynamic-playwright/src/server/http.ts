export function errorResponse(error: unknown, runStart: number): Response {
  return Response.json(
    {
      error: error instanceof Error ? error.message : String(error),
      runMs: Date.now() - runStart
    },
    { status: 500 }
  );
}

export function notFoundResponse(runStart: number): Response {
  return Response.json(
    { error: "Not found", runMs: Date.now() - runStart },
    { status: 404 }
  );
}
