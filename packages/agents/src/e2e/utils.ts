import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export async function waitForWorker(
  url: string,
  { timeoutMs = 30_000, intervalMs = 1000 } = {}
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(new URL("/health", url));
      const text = await res.text();

      // treat as ready when it's not the placeholder page
      if (res.ok && text === "OK") {
        console.log("Worker ready");
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Worker at ${url} not ready after ${timeoutMs}ms`);
}

// Helper to pull the first text content from an MCP tool result
export function textOf(result: unknown): string | undefined {
  if (result && typeof result === "object" && "content" in result) {
    const content = Array.isArray(result?.content) ? result.content : [];
    const block = content.find((c: { type: string }) => c && c.type === "text");
    return block?.text;
  }
}

export async function registerClient(base: URL) {
  const res = await fetch(new URL("/register", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "e2e",
      token_endpoint_auth_method: "none",
      redirect_uris: ["http://localhost/callback"],
      grant_types: ["implicit", "authorization_code"],
      response_types: ["token", "code"]
    })
  });
  const j = (await res.json()) as { client_id: string };
  return j.client_id;
}

export async function headlessImplicitToken(
  base: URL,
  clientId: string,
  email: string
) {
  const u = new URL("/authorize", base);
  u.searchParams.set("response_type", "token");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", "http://localhost/callback");
  u.searchParams.set("scope", "profile");
  u.searchParams.set("email", email);
  u.searchParams.set("password", "x");

  const res = (await (await fetch(u)).json()) as { fragment?: string };
  const params = new URLSearchParams(res.fragment);
  const token = params.get("access_token");
  if (!token) throw new Error("No access_token in FRAGMENT");
  return token;
}

export async function sendPostRequest(
  url: string,
  message: JSONRPCMessage | JSONRPCMessage[],
  sessionId?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json"
  };

  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }

  const res = fetch(url, {
    body: JSON.stringify(message),
    headers,
    method: "POST"
  });

  return res;
}
