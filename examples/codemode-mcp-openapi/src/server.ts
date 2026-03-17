import { createMcpHandler } from "agents/mcp";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { openApiMcpServer } from "@cloudflare/codemode/mcp";

const CLOUDFLARE_SPEC_URL =
  "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json";

let specCache: Record<string, unknown> | null = null;

async function getSpec(): Promise<Record<string, unknown>> {
  if (specCache) return specCache;
  const res = await fetch(CLOUDFLARE_SPEC_URL);
  if (!res.ok) throw new Error(`Failed to fetch spec: ${res.status}`);
  specCache = (await res.json()) as Record<string, unknown>;
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
        JSON.stringify({
          error: "Authorization header with Bearer token required"
        }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const spec = await getSpec();
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const server = openApiMcpServer({
      spec,
      executor,
      name: "cloudflare",
      description: `This server wraps the Cloudflare API. Replace path parameters like {account_id} and {zone_id} with real values from a prior search or list call.

// List all zones (accounts the token can access)
async () => {
  return await codemode.request({ method: "GET", path: "/zones" });
}

// List Workers scripts in an account
async () => {
  const zones = await codemode.request({ method: "GET", path: "/zones" });
  const accountId = zones.result[0].account.id;
  return await codemode.request({
    method: "GET",
    path: \`/accounts/\${accountId}/workers/scripts\`
  });
}

// Create a DNS record
async () => {
  return await codemode.request({
    method: "POST",
    path: "/zones/{zone_id}/dns_records",
    body: { type: "A", name: "example.com", content: "1.2.3.4", ttl: 3600 }
  });
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
