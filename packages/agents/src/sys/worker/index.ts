import { getAgentByName } from "../..";
import html from "./client.html";
import type { AgentBlueprint, ThreadRequestContext } from "../types";
import type { KVNamespace } from "@cloudflare/workers-types";
import type { SystemAgent } from "../agent";
import type { Agency } from "../agent/agency";

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

export type HandlerOptions = {
  baseUrl?: string;
  /** Secret to use for authorization. Optional means no check. */
  secret?: string;
  agentDefinitions?: AgentBlueprint[];
};

type HandlerEnv = {
  SYSTEM_AGENT: DurableObjectNamespace<SystemAgent>;
  AGENCY: DurableObjectNamespace<Agency>;
  AGENCY_REGISTRY: KVNamespace;
};

export const createHandler = (opts: HandlerOptions = {}) => {
  return {
    async fetch(req: Request, env: HandlerEnv, _ctx: ExecutionContext) {
      const url = new URL(req.url);
      const path = url.pathname;

      // 1. Dashboard
      if (req.method === "GET" && path === "/") {
        return new Response(html, {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }

      // 2. Auth check
      if (opts.secret && req.headers.get("X-SECRET") !== opts.secret) {
        return new Response("Unauthorized", { status: 401 });
      }

      // ======================================================
      // Root: Agency Management (KV-backed)
      // ======================================================

      // GET /agencies -> List all agencies
      if (req.method === "GET" && path === "/agencies") {
        const list = await env.AGENCY_REGISTRY.list();
        const agencies = [];

        for (const key of list.keys) {
          const meta = await env.AGENCY_REGISTRY.get(key.name);
          agencies.push(meta ? JSON.parse(meta) : { id: key.name });
        }

        return Response.json({ agencies });
      }

      // POST /agencies -> Create a new Agency
      if (req.method === "POST" && path === "/agencies") {
        const body = await req
          .json<{ name?: string }>()
          .catch(() => ({}) as { name?: string });

        // Use a proper Durable Object ID
        const id = env.AGENCY.newUniqueId().toString();
        const meta = {
          id,
          name: body.name || "Untitled Agency",
          createdAt: new Date().toISOString()
        };

        await env.AGENCY_REGISTRY.put(id, JSON.stringify(meta));
        return Response.json(meta, { status: 201 });
      }

      // ======================================================
      // Hierarchical Routing: /agency/:agencyId/...
      // ======================================================

      const matchAgency = path.match(/^\/agency\/([^/]+)(.*)$/);
      if (matchAgency) {
        const agencyId = matchAgency[1];
        const subPath = matchAgency[2] || "/"; // e.g. /agents, /blueprints, /agent/:id

        let agencyStub: DurableObjectStub<Agency>;
        try {
          agencyStub = env.AGENCY.get(env.AGENCY.idFromString(agencyId));
        } catch (e) {
          return new Response("Invalid Agency ID", { status: 400 });
        }

        // --------------------------------------
        // Agency-level operations
        // --------------------------------------

        // GET /agency/:id/blueprints -> merge defaults + DO overrides
        if (req.method === "GET" && subPath === "/blueprints") {
          const res = await agencyStub.fetch(
            new Request("http://do/blueprints", req)
          );
          if (!res.ok) return res;

          const dynamic = await res.json<{ blueprints: AgentBlueprint[] }>();
          const combined = new Map<string, AgentBlueprint>();

          // 1. Static defaults
          (opts.agentDefinitions || []).forEach((b) => {
            combined.set(b.name, b);
          });

          // 2. Overrides (Agency wins)
          dynamic.blueprints.forEach((b) => {
            combined.set(b.name, b);
          });

          return Response.json({ blueprints: Array.from(combined.values()) });
        }

        // POST /agency/:id/blueprints -> pass through to Agency DO
        if (req.method === "POST" && subPath === "/blueprints") {
          return agencyStub.fetch(new Request("http://do/blueprints", req));
        }

        // GET /agency/:id/agents
        if (req.method === "GET" && subPath === "/agents") {
          return agencyStub.fetch(new Request("http://do/agents", req));
        }

        // POST /agency/:id/agents -> spawn agent
        if (req.method === "POST" && subPath === "/agents") {
          const body = await req.json<any>();
          body.requestContext = buildRequestContext(req);

          return agencyStub.fetch(
            new Request("http://do/agents", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body)
            })
          );
        }

        // --------------------------------------
        // Agent-level operations
        // /agency/:id/agent/:agentId/*
        // --------------------------------------

        const matchAgent = subPath.match(/^\/agent\/([^/]+)(.*)$/);
        if (matchAgent) {
          const agentId = matchAgent[1];
          const agentTail = matchAgent[2] || ""; // e.g. /invoke, /state, /ws

          const systemAgentStub = await getAgentByName(
            env.SYSTEM_AGENT,
            agentId
          );

          const doUrl = new URL(req.url);
          doUrl.pathname = agentTail; // strip /agency/:id/agent/:agentId

          let doReq: Request;

          // POST /invoke -> inject threadId
          if (agentTail === "/invoke" && req.method === "POST") {
            const body = await req.json<Record<string, unknown>>();
            body.threadId = agentId;

            doReq = new Request(doUrl, {
              method: req.method,
              headers: req.headers,
              body: JSON.stringify(body)
            });
          } else {
            doReq = new Request(doUrl, req);
          }

          return systemAgentStub.fetch(doReq);
        }
      }

      return new Response("Not found", { status: 404 });
    }
  };
};
