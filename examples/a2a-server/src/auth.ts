import {
  authenticateRequest,
  createServerCallContext as createRuntimeServerCallContext
} from "./runtime/auth";

export { authenticateRequest };

export function createServerCallContext(request: Request) {
  return createRuntimeServerCallContext(request, "shared-secret-client");
}

/** Returns the standard 401 response for this server's bearer authentication. */
export function unauthorizedResponse(): Response {
  return Response.json(
    { error: "Unauthorized" },
    {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="a2a"' }
    }
  );
}
