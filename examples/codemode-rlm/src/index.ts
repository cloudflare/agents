import { getAgentByName } from "agents";
import { boundedInteger, requireString } from "./core";
import { RlmChildAgent, RlmThinkAgent } from "./agent";

export { RlmChildAgent, RlmThinkAgent };
export { CodemodeRuntime } from "@cloudflare/codemode";

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

function requestResponse(data: Record<string, unknown>): Response {
  return json(
    data,
    data.status === "admitted" || data.status === "running" ? 202 : 200
  );
}

function errorStatus(message: string): number {
  if (/\bnot found\b/.test(message)) return 404;
  if (
    /\b(reused|conflict|already|still (?:admitted|running))\b/.test(message)
  ) {
    return 409;
  }
  if (
    /\b(must|may contain|at most|at least|send either|valid JSON|non-negative integer)\b/.test(
      message
    )
  ) {
    return 400;
  }
  return 500;
}

async function body(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

function authorized(request: Request, env: Env): Response | undefined {
  if (!env.API_TOKEN) {
    return json(
      {
        error:
          "API_TOKEN is not configured; set it as a Worker secret before using session routes"
      },
      503
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${env.API_TOKEN}`) {
    return Response.json(
      { error: "unauthorized" },
      {
        status: 401,
        headers: {
          "cache-control": "no-store",
          "www-authenticate": "Bearer"
        }
      }
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return json({
        name: "codemode-rlm",
        architecture:
          "Think owns durable turns and retained sub-agents; the model sees only Code Mode.",
        usage:
          "POST /sessions/:session/think, then poll GET /sessions/:session/requests?requestId=...",
        endpoints: [
          "GET /sessions/:session",
          "POST /sessions/:session/think",
          "POST /sessions/:session/refine",
          "GET /sessions/:session/requests?requestId=...",
          "POST /sessions/:session/rollback",
          "GET /sessions/:session/history",
          "GET /sessions/:session/children",
          "GET /sessions/:session/harness",
          "GET /sessions/:session/executions",
          "GET|POST /sessions/:session/snippets"
        ]
      });
    }

    const authResponse = authorized(request, env);
    if (authResponse) return authResponse;

    const match = /^\/sessions\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return json({ error: "route not found" }, 404);

    let session: string;
    try {
      session = requireString(decodeURIComponent(match[1]), "session", {
        min: 1,
        max: 120
      });
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        400
      );
    }

    const action = match[2] ?? "";
    const agent = await getAgentByName(env.RlmThinkAgent, session);
    try {
      if (request.method === "GET" && action === "") {
        return json(await agent.sessionSummary());
      }
      if (request.method === "POST" && action === "think") {
        return requestResponse(await agent.runThink(await body(request)));
      }
      if (request.method === "POST" && action === "refine") {
        return requestResponse(await agent.refineHarness(await body(request)));
      }
      if (request.method === "POST" && action === "rollback") {
        return json(await agent.rollbackHarness(await body(request)));
      }
      if (request.method === "GET" && action === "history") {
        return json(
          await agent.history(
            boundedInteger(url.searchParams.get("limit"), 20, 1, 50)
          )
        );
      }
      if (request.method === "GET" && action === "requests") {
        return requestResponse(
          await agent.requestStatus(url.searchParams.get("requestId"))
        );
      }
      if (request.method === "GET" && action === "children") {
        return json(
          await agent.children(
            boundedInteger(url.searchParams.get("limit"), 20, 1, 100)
          )
        );
      }
      if (request.method === "GET" && action === "harness") {
        return json(await agent.harness());
      }
      if (request.method === "GET" && action === "executions") {
        return json(
          await agent.executions(
            boundedInteger(url.searchParams.get("limit"), 20, 1, 50)
          )
        );
      }
      if (request.method === "GET" && action === "snippets") {
        return json(await agent.snippets());
      }
      if (request.method === "POST" && action === "snippets") {
        return json(await agent.promoteSnippet(await body(request)), 201);
      }
      return json({ error: "route not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, errorStatus(message));
    }
  }
} satisfies ExportedHandler<Env>;
