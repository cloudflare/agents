import type { CORSOptions } from "./types";

// CORS helper functions
export function corsHeaders(_request: Request, corsOptions: CORSOptions = {}) {
  const origin = "*";
  return {
    "Access-Control-Allow-Headers":
      corsOptions.headers ||
      "Content-Type, Accept, mcp-session-id, mcp-protocol-version",
    "Access-Control-Allow-Methods":
      corsOptions.methods || "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Origin": corsOptions.origin || origin,
    "Access-Control-Expose-Headers":
      corsOptions.exposeHeaders || "mcp-session-id",
    "Access-Control-Max-Age": (corsOptions.maxAge || 86400).toString()
  };
}

export function handleCORS(
  request: Request,
  corsOptions?: CORSOptions
): Response | null {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(request, corsOptions) });
  }

  return null;
}

export function isDurableObjectNamespace(
  namespace: unknown
): namespace is DurableObjectNamespace {
  return (
    typeof namespace === "object" &&
    namespace !== null &&
    "newUniqueId" in namespace &&
    typeof namespace.newUniqueId === "function" &&
    "idFromName" in namespace &&
    typeof namespace.idFromName === "function"
  );
}
