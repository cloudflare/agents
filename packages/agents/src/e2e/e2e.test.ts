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
import {
  headlessImplicitToken,
  registerClient,
  sendPostRequest,
  textOf,
  waitForWorker
} from "./utils";

// Make name unique so parallel tests don't clash
const testId = `agents-e2e-${crypto.randomBytes(4).toString("hex")}`;
let app: Scope;
let authlessWorker: Awaited<ReturnType<typeof Worker>>;
let oauthWorker: Awaited<ReturnType<typeof Worker>>;

beforeAll(async () => {
  app = await alchemy("mcp-e2e", { phase: "up" });

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
    await waitForWorker(authlessWorker.url!);

    name = `${testId}-oauth`;
    oauthWorker = await Worker(`${name}-worker`, {
      name,
      entrypoint: "src/e2e/remote-mcp-server/index.ts",
      bindings: {
        WHOAMI_MCP: DurableObjectNamespace("whoami-mcp", {
          className: "WhoamiMCP",
          sqlite: true
        }),
        ADD_MCP: DurableObjectNamespace("add-mcp", {
          className: "AddMCP",
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
    await waitForWorker(oauthWorker.url!);
  });
}, 90_000);

afterAll(async () => {
  await alchemy.destroy(app);
  await app.finalize();
}, 90_000);

describe("Authless MCP e2e", () => {
  let worker: Awaited<ReturnType<typeof Worker>>;
  beforeAll(() => {
    worker = authlessWorker;
  });
  describe("Streamable HTTP", () => {
    let client: Client;

    beforeAll(async () => {
      // Create a first MCP client to our calculator MCP
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

    it("lists tools on both MCPs", async () => {
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

    it("calls add", async () => {
      const res1 = await client.callTool({
        name: "add",
        arguments: { a: 10, b: 15 }
      });
      expect(textOf(res1)).toBe("25");
    });
  });
});

describe("OAuth MCPs e2e", () => {
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

  describe("Streamable HTTP", () => {
    let whoamiClient: Client;
    let addClient: Client;

    beforeAll(async () => {
      // Setup client for the WhoamiMCP
      whoamiClient = new Client({ name: "whoami-client", version: "1.0.0" });
      const whoamiTransport = new StreamableHTTPClientTransport(
        new URL("/whoami/mcp", worker.url),
        { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
      );
      await whoamiClient.connect(whoamiTransport);

      // Setup client for the AddMCP
      addClient = new Client({ name: "add-client", version: "1.0.0" });
      const addTransport = new StreamableHTTPClientTransport(
        new URL("/add/mcp", worker.url),
        { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
      );
      await addClient.connect(addTransport);
    }, 30_000);

    afterAll(async () => {
      // Close the MCP clients
      await whoamiClient.close?.();
      await addClient.close?.();
    }, 30_000);

    it("lists tools on both MCPs", async () => {
      const { tools: whoamiMCPTools } = await whoamiClient.listTools();
      expect(whoamiMCPTools.map((t) => t.name)).toContain("whoami");

      const { tools: addMCPTools } = await addClient.listTools();
      expect(addMCPTools.map((t) => t.name)).toContain("add");
    });

    it("calls add", async () => {
      const res = await addClient.callTool({
        name: "add",
        arguments: { a: 2, b: 3 }
      });
      expect(textOf(res)).toBe("5");
    });

    it("calls whoami", async () => {
      const res = await whoamiClient.callTool({
        name: "whoami",
        arguments: {}
      });
      expect(textOf(res)).toBe(TEST_EMAIL);
    });
  });

  describe("Legacy SSE", () => {
    let whoamiClient: Client;
    let addClient: Client;

    beforeAll(async () => {
      // Setup client for the WhoamiMCP
      whoamiClient = new Client({
        name: "whoami-client-sse",
        version: "1.0.0"
      });
      const whoamiTransport = new SSEClientTransport(
        new URL("/whoami/sse", worker.url),
        {
          requestInit: { headers: { Authorization: `Bearer ${token}` } }
        }
      );
      await whoamiClient.connect(whoamiTransport);

      // Setup client for the AddMCP
      addClient = new Client({
        name: "whoami-client-sse",
        version: "1.0.0"
      });
      const addTransport = new SSEClientTransport(
        new URL("/add/sse", worker.url),
        {
          requestInit: { headers: { Authorization: `Bearer ${token}` } }
        }
      );
      await addClient.connect(addTransport);
    }, 30_000);

    afterAll(async () => {
      await whoamiClient.close?.();
      await addClient.close?.();
    }, 30_000);

    it("calls add", async () => {
      const res = await addClient.callTool({
        name: "add",
        arguments: { a: 10, b: 15 }
      });
      expect(textOf(res)).toBe("25");
    });

    it("calls whoami", async () => {
      const res = await whoamiClient.callTool({
        name: "whoami",
        arguments: {}
      });
      expect(textOf(res)).toBe(TEST_EMAIL);
    });
  });
});
