import { createMcpHandler } from "agents/mcp";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { openApiMcpServer } from "@cloudflare/codemode/mcp";

const CLOUDFLARE_SPEC_URL =
  "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json";

let specCache: unknown = null;

async function getSpec(): Promise<unknown> {
  if (specCache) return specCache;
  const res = await fetch(CLOUDFLARE_SPEC_URL);
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
    // Extract API token from Authorization header
    const authHeader = request.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!token) {
      return new Response(
        JSON.stringify({ error: "Authorization header with Bearer token required" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const spec = await getSpec();
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const server = openApiMcpServer({
      spec,
      executor,
      name: "cloudflare",
      extraDescription: `// List all zones
async () => {
  return await codemode.request({ method: "GET", path: "/zones" });
}

// List Workers scripts
async () => {
  return await codemode.request({ method: "GET", path: "/accounts/{account_id}/workers/scripts" });
}

// Get DNS records for a zone
async () => {
  return await codemode.request({ method: "GET", path: "/zones/{zone_id}/dns_records" });
}`,
      // This is where you call your API. Runs on the host — auth, base URL,
      // headers are all yours. The sandbox never sees tokens or secrets.
      request: async (opts) => {
        const url = new URL(`https://api.cloudflare.com/client/v4${opts.path}`);
        if (opts.query) {
          for (const [key, value] of Object.entries(opts.query)) {
            if (value !== undefined) url.searchParams.set(key, String(value));
          }
        }

        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`
        };
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

        return await res.json();
      }
    });

    return createMcpHandler(server)(request, env, ctx);
  }
};
