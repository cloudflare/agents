import { getAgentByName } from "agents";
import { RlmChildAgent, RlmThinkAgent } from "./agent";
import { BasicThinkAgent } from "./baseline";
import { boundedInteger, observedRuntimeConfig, requireString } from "./core";
import { summarizeMessages } from "./diagnostics";

export { BasicThinkAgent, RlmChildAgent, RlmThinkAgent };
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
  if (import.meta.env.DEV) return;
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
    const isEvalRoute =
      url.pathname === "/eval" || url.pathname.startsWith("/eval/");
    if (isEvalRoute && !import.meta.env.DEV) {
      return json({ error: "route not found" }, 404);
    }

    const authResponse = authorized(request, env);
    if (authResponse) return authResponse;

    if (url.pathname === "/eval/config") {
      if (request.method !== "GET") {
        return json({ error: "route not found" }, 404);
      }
      return json(observedRuntimeConfig(env));
    }

    const rlmEvalMatch = /^\/eval\/rlm\/([^/]+)$/.exec(url.pathname);
    if (rlmEvalMatch) {
      if (request.method !== "GET") {
        return json({ error: "route not found" }, 404);
      }

      let session: string;
      try {
        session = requireString(
          decodeURIComponent(rlmEvalMatch[1]),
          "session",
          {
            min: 1,
            max: 120
          }
        );
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          400
        );
      }

      try {
        const agent = await getAgentByName(env.RlmThinkAgent, session);
        return json({
          diagnostics: summarizeMessages(await agent.getMessages())
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: message }, errorStatus(message));
      }
    }

    const baselineMatch = /^\/eval\/baselines\/([^/]+)$/.exec(url.pathname);
    if (baselineMatch) {
      if (request.method !== "GET" && request.method !== "POST") {
        return json({ error: "route not found" }, 404);
      }

      let trial: string;
      try {
        trial = requireString(decodeURIComponent(baselineMatch[1]), "trial", {
          min: 1,
          max: 120
        });
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          400
        );
      }
      const baseline = await getAgentByName(env.BasicThinkAgent, trial);
      try {
        if (request.method === "GET") {
          return json({
            diagnostics: summarizeMessages(await baseline.getMessages())
          });
        }
        return requestResponse(await baseline.evaluate(await body(request)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: message }, errorStatus(message));
      }
    }

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
      if (request.method === "POST" && action === "think") {
        return requestResponse(await agent.runThink(await body(request)));
      }
      if (request.method === "POST" && action === "refine") {
        return requestResponse(await agent.refineHarness(await body(request)));
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
      return json({ error: "route not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, errorStatus(message));
    }
  }
} satisfies ExportedHandler<Env>;
