import { getAgentByName, type Agent } from "../..";
import html from "./client.html";
import type {
  AgentBlueprint,
  ThreadMetadata,
  ThreadRequestContext
} from "../types";
import type { KVNamespace } from "@cloudflare/workers-types";

const CF_CONTEXT_KEYS = [
  "colo",
  "country",
  "city",
  "region",
  "timezone",
  "postalCode",
  "asOrganization"
] as const;

type CfRequest = Request & { cf?: Record<string, unknown> };

function buildRequestContext(req: Request): ThreadRequestContext {
  const headers = req.headers;
  const cf = (req as CfRequest).cf ?? undefined;
  const context: ThreadRequestContext = {
    userAgent: headers.get("user-agent") ?? undefined,
    ip: headers.get("cf-connecting-ip") ?? undefined,
    referrer: headers.get("referer") ?? undefined,
    origin: headers.get("origin") ?? undefined
  };
  if (cf) {
    const filtered: Record<string, unknown> = {};
    for (const key of CF_CONTEXT_KEYS) {
      const value = (cf as Record<string, unknown>)[key];
      if (value !== undefined) filtered[key] = value;
    }
    if (Object.keys(filtered).length > 0) {
      context.cf = filtered;
    }
  }
  return context;
}

async function saveThreadMetadata(
  registry: KVNamespace,
  metadata: ThreadMetadata
) {
  await registry.put(metadata.id, JSON.stringify(metadata));
}

async function readThreadMetadata(
  registry: KVNamespace,
  id: string
): Promise<ThreadMetadata | null> {
  const raw = await registry.get(id);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ThreadMetadata;
  } catch (error) {
    console.error("Failed to parse thread metadata", error);
    return null;
  }
}

async function listThreads(registry: KVNamespace): Promise<ThreadMetadata[]> {
  const { keys } = await registry.list();
  if (!keys.length) return [];
  const items = await Promise.all(
    keys.map(async (entry) => readThreadMetadata(registry, entry.name))
  );
  return items
    .filter((item): item is ThreadMetadata => item !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export type HandlerOptions = {
  baseUrl?: string;
  /** Secret to use for authorization. Optional means no check. */
  secret?: string;
  agentDefinitions?: AgentBlueprint[];
};

type HandlerEnv = {
  DEEP_AGENT: DurableObjectNamespace<Agent>;
  AGENT_REGISTRY: KVNamespace;
};

/**
 * Creates a Worker entrypoint handler. Example usage:
 *
 * ```typescript
 * import { createAgentThread } from "./worker";
 * import { createHandler } from "./handler";
 *
 * const AgentThread = createAgentThread({
 *   provider: makeOpenAI(env.OPENAI_API_KEY, env.OPENAI_BASE_URL),
 * });
 *
 * export AgentThread;
 * export default createHandler(); // this is the entrypoint to the worker
 * ```
 */
export const createHandler = (opts: HandlerOptions = {}) => {
  return {
    async fetch(req: Request, env: HandlerEnv, _ctx: ExecutionContext) {
      const url = new URL(req.url);

      // Serve dashboard client
      if (req.method === "GET" && url.pathname === "/") {
        return new Response(html, {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }

      if (opts.secret && req.headers.get("X-SECRET") !== opts.secret) {
        return new Response("invalid secret", { status: 401 });
      }

      if (req.method === "GET" && url.pathname === "/info") {
        // Transform blueprints into a clean list for the UI
        const agents = (opts.agentDefinitions || []).map((b) => ({
          name: b.name,
          description: b.description
        }));
        return Response.json({ agents });
      }

      if (req.method === "GET" && url.pathname === "/threads") {
        const threads = await listThreads(env.AGENT_REGISTRY);
        return Response.json({ threads });
      }

      if (req.method === "POST" && url.pathname === "/threads") {
        const body = (await req.json().catch(() => ({}))) as {
          agentType?: string;
        };

        // Default to "default" or "base-agent" if not specified
        const agentType = body.agentType || "default";

        const id = crypto.randomUUID();
        const metadata: ThreadMetadata = {
          id,
          createdAt: new Date().toISOString(),
          request: buildRequestContext(req),
          agentType
        };
        const stub = await getAgentByName(env.DEEP_AGENT, id);
        const registerRes = await stub.fetch(
          new Request("http://do/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(metadata)
          })
        );
        if (!registerRes.ok) {
          return new Response("failed to register thread", { status: 500 });
        }

        await saveThreadMetadata(env.AGENT_REGISTRY, metadata);

        return Response.json(
          { id, createdAt: metadata.createdAt, agentType },
          { status: 201 }
        );
      }

      const match = url.pathname.match(/^\/threads\/([^/]+)(?:\/(.*))?$/);
      if (!match) return new Response("not found", { status: 404 });
      const [_, threadId, tail] = match;
      const stub = await getAgentByName(env.DEEP_AGENT, threadId);

      // Create a new request with the path that the DO expects
      const doUrl = new URL(req.url);
      doUrl.pathname = `/${tail || ""}`;

      // For invoke requests, inject threadId into the body
      let doReq: Request;
      if (tail === "invoke" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        body.threadId = threadId;
        doReq = new Request(doUrl, {
          method: req.method,
          headers: req.headers,
          body: JSON.stringify(body)
        });
      } else {
        doReq = new Request(doUrl, req);
      }

      if (tail === "invoke" && req.method === "POST") return stub.fetch(doReq);
      if (tail === "approve" && req.method === "POST") return stub.fetch(doReq);
      if (tail === "cancel" && req.method === "POST") return stub.fetch(doReq);
      if (tail === "state" && req.method === "GET") return stub.fetch(doReq);
      if (tail === "events" && req.method === "GET") return stub.fetch(doReq);
      if (tail === "ws" && req.headers.get("upgrade") === "websocket")
        return stub.fetch(doReq);
      if (tail === "child_result" && req.method === "POST")
        return stub.fetch(doReq);

      return new Response("not found", { status: 404 });
    }
  };
};
