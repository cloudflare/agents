import { createMcpHandler } from "agents/mcp";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { openApiMcpServer } from "@cloudflare/codemode/mcp";

const GITHUB_SPEC_URL =
  "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json";

let specCache: unknown = null;

async function getSpec(): Promise<unknown> {
  if (specCache) return specCache;
  const res = await fetch(GITHUB_SPEC_URL);
  if (!res.ok) throw new Error(`Failed to fetch spec: ${res.status}`);
  specCache = await res.json();
  return specCache;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const spec = await getSpec();
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const server = openApiMcpServer({
      spec,
      executor,
      name: "github",
      extraDescription: `// List repositories for a user
async () => {
  return await codemode.request({ method: "GET", path: "/users/octocat/repos" });
}

// Create an issue
async () => {
  return await codemode.request({
    method: "POST",
    path: "/repos/owner/repo/issues",
    body: { title: "Bug report", body: "Description here" }
  });
}

// Search code
async () => {
  return await codemode.request({ method: "GET", path: "/search/code", query: { q: "language:go" } });
}`,
      // This is where you call your API. Runs on the host — auth, base URL,
      // headers are all yours. The sandbox never sees tokens or secrets.
      request: async (opts) => {
        const url = new URL(`https://api.github.com${opts.path}`);
        if (opts.query) {
          for (const [key, value] of Object.entries(opts.query)) {
            if (value !== undefined) url.searchParams.set(key, String(value));
          }
        }

        const headers: Record<string, string> = {
          Accept: "application/vnd.github+json",
          "User-Agent": "codemode-mcp-openapi-example"
        };
        if (env.GITHUB_TOKEN) {
          headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
        }
        if (opts.contentType) {
          headers["Content-Type"] = opts.contentType;
        } else if (opts.body) {
          headers["Content-Type"] = "application/json";
        }

        const res = await fetch(url.toString(), {
          method: opts.method,
          headers,
          body: opts.body
            ? opts.rawBody
              ? (opts.body as string)
              : JSON.stringify(opts.body)
            : undefined
        });

        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          return await res.json();
        }
        return await res.text();
      }
    });

    return createMcpHandler(server)(request, env, ctx);
  }
};
