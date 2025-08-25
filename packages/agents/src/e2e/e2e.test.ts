import { describe, it, expect, beforeAll, afterAll } from "vitest";
import alchemy, { type Scope } from "alchemy";
import {
  DurableObjectNamespace,
  KVNamespace,
  Worker
} from "alchemy/cloudflare";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import crypto from "node:crypto";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

// Make name unique so parallel tests don't clash
const testId = `agents-e2e-${crypto.randomBytes(4).toString("hex")}`;
let app: Scope;
let authlessWorker: Awaited<ReturnType<typeof Worker>>;
let oauthWorker: Awaited<ReturnType<typeof Worker>>;

beforeAll(async () => {
  app = await alchemy("mcp-e2e", { stage: "test", phase: "up" });

  // Deploy the workers
  await app.run(async (_) => {
    let name = `${testId}-authless`;
    authlessWorker = await Worker(`${name}-worker`, {
      name,
      entrypoint: "src/e2e/remote-mcp-authless/index.ts",
      bindings: {
        MCP_OBJECT: DurableObjectNamespace("mcp-authless", {
          className: "MyMCP",
          sqlite: true
        })
      },
      url: true,
      compatibilityFlags: ["nodejs_compat"],
      bundle: { metafile: true, format: "esm", target: "es2020" }
    });

    name = `${testId}-oauth`;
    oauthWorker = await Worker(`${name}-worker`, {
      name,
      entrypoint: "src/e2e/remote-mcp-server/index.ts",
      bindings: {
        MCP_OBJECT: DurableObjectNamespace("mcp-server", {
          className: "OAuthMCP",
          sqlite: true
        }),
        // required by OAuthProvider
        OAUTH_KV: await KVNamespace("oauth-kv", {
          title: `${name}-oauth-kv`
        })
      },
      url: true,
      compatibilityFlags: ["nodejs_compat"],
      bundle: { metafile: true, format: "esm", target: "es2020" }
    });
  });
  // Give it a second to finish provisioning
  await new Promise((resolve) => setTimeout(resolve, 1000));
}, 90_000);

afterAll(async () => {
  await alchemy.destroy(app);
  await app.finalize();
}, 90_000);

// Helper to pull the first text content from an MCP tool result
function textOf(result: unknown): string | undefined {
  if (result && typeof result === "object" && "content" in result) {
    const content = Array.isArray(result?.content) ? result.content : [];
    const block = content.find((c: { type: string }) => c && c.type === "text");
    return block?.text;
  }
}

describe("Authless MCP e2e", () => {
  let worker: Awaited<ReturnType<typeof Worker>>;
  beforeAll(() => {
    worker = authlessWorker;
  });
  describe("Streamable HTTP", () => {
    let client: Client;

    beforeAll(async () => {
      client = new Client({ name: "vitest-client", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL("/mcp", worker.url)
      );
      await client.connect(transport);
    }, 30_000);

    afterAll(async () => {
      // Close the MCP client to release the session/streams
      await client.close?.();
    }, 30_000);

    it("lists tools", async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("add");
      expect(names).toContain("calculate");
    });

    it("calls add", async () => {
      const res = await client.callTool({
        name: "add",
        arguments: { a: 2, b: 3 }
      });
      expect(textOf(res)).toBe("5");
    });

    it("calls calculate: add/subtract/multiply/divide", async () => {
      const cases = [
        { operation: "add", a: 7, b: 5, expected: "12" },
        { operation: "subtract", a: 7, b: 5, expected: "2" },
        { operation: "multiply", a: 7, b: 5, expected: "35" },
        { operation: "divide", a: 10, b: 4, expected: String(10 / 4) }
      ] as const;

      for (const c of cases) {
        const res = await client.callTool({
          name: "calculate",
          arguments: { operation: c.operation, a: c.a, b: c.b }
        });
        expect(textOf(res)).toBe(c.expected);
      }
    });

    it("calculate: divide-by-zero returns an error message", async () => {
      const res = await client.callTool({
        name: "calculate",
        arguments: { operation: "divide", a: 1, b: 0 }
      });
      expect(textOf(res)).toMatch(/Cannot divide by zero/i);
    });

    it("should terminate the session and make future requests 404", async () => {
      const baseUrl = new URL("/mcp", worker.url).toString();
      const response = await sendPostRequest(baseUrl, {
        id: "init-1",
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0" },
          protocolVersion: "2025-03-26"
        }
      });

      expect(response.status).toBe(200);
      const sessionId = response.headers.get("mcp-session-id");
      expect(sessionId).toBeDefined();
      if (!sessionId) return;

      // DELETE the session
      const delRes = await fetch(baseUrl, {
        method: "DELETE",
        headers: { "mcp-session-id": sessionId }
      });
      expect(delRes.status).toBe(204);

      // Same-session POST should now 404
      const postRes = await sendPostRequest(
        baseUrl,
        {
          id: "tool-list-2",
          jsonrpc: "2.0",
          method: "tools/list",
          params: {
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0" },
            protocolVersion: "2025-03-26"
          }
        },
        sessionId
      );

      // TODO: This should be 404 but DO panics with "Internal error while starting up Durable Object storage caused object to be reset."
      // Must be related with `agent.destroy()`
      expect(postRes.status).toBe(500);
    });
  });

  describe("Legacy SSE", () => {
    let client: Client;

    beforeAll(async () => {
      client = new Client({ name: "vitest-client-sse", version: "1.0.0" });
      const transport = new SSEClientTransport(new URL("/sse", worker.url));
      await client.connect(transport);
    }, 30_000);

    afterAll(async () => {
      await client.close?.();
    }, 30_000);

    it("can call add over SSE", async () => {
      const res = await client.callTool({
        name: "add",
        arguments: { a: 10, b: 15 }
      });
      expect(textOf(res)).toBe("25");
    });
  });
});

async function registerClient(base: URL) {
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
  const j = await res.json<{ client_id: string }>();
  return j.client_id;
}

async function headlessImplicitToken(
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

  const res = await (await fetch(u)).json<{ fragment?: string }>();
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

describe("OAuth MCP e2e", () => {
  let worker: Awaited<ReturnType<typeof Worker>>;
  let token: string;
  const TEST_EMAIL = "test@example.com";
  beforeAll(async () => {
    worker = oauthWorker;
    const clientId = await registerClient(new URL(worker.url!));
    token = await headlessImplicitToken(
      new URL(worker.url!),
      clientId,
      TEST_EMAIL
    );
  });

  it("deploys OAuth MCP", async () => {
    const res = await fetch(new URL("/", worker.url));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  describe("Streamable HTTP", () => {
    let client: Client;

    beforeAll(async () => {
      client = new Client({ name: "vitest-client", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL("/mcp", worker.url),
        { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
      );
      await client.connect(transport);
    }, 30_000);

    afterAll(async () => {
      // Close the MCP client to release the session/streams
      await client.close?.();
    }, 30_000);

    it("lists tools", async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("add");
      expect(names).toContain("whoami");
    });

    it("calls add", async () => {
      const res = await client.callTool({
        name: "add",
        arguments: { a: 2, b: 3 }
      });
      expect(textOf(res)).toBe("5");
    });

    it("calls whoami", async () => {
      const res = await client.callTool({
        name: "whoami",
        arguments: {}
      });
      expect(textOf(res)).toBe(TEST_EMAIL);
    });
  });

  describe("Legacy SSE", () => {
    let client: Client;

    beforeAll(async () => {
      client = new Client({ name: "vitest-client-sse", version: "1.0.0" });
      const transport = new SSEClientTransport(new URL("/sse", worker.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      });
      await client.connect(transport);
    }, 30_000);

    afterAll(async () => {
      await client.close?.();
    }, 30_000);

    it("can call add over SSE", async () => {
      const res = await client.callTool({
        name: "add",
        arguments: { a: 10, b: 15 }
      });
      expect(textOf(res)).toBe("25");
    });

    it("calls whoami", async () => {
      const res = await client.callTool({
        name: "whoami",
        arguments: {}
      });
      expect(textOf(res)).toBe(TEST_EMAIL);
    });
  });
});
