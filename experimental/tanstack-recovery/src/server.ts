/**
 * tanstack-recovery worker entry.
 *
 * Routes WebSocket connects to the `TanStackAgent` Durable Object (so the shared
 * `ResumeHandshake` runs against a foreign `@tanstack/ai` client transport), plus
 * a small HTTP control surface the SIGKILL e2e uses: start a turn and poll
 * recovery status. See `tanstack-agent.ts`.
 *
 * @internal Validation fixture, not a published package.
 */
import { getAgentByName, routeAgentRequest } from "agents";
import { TanStackAgent, type Env } from "./tanstack-agent";

export { TanStackAgent };

async function stub(env: Env, session: string) {
  return getAgentByName(env.TanStackAgent, session);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const session = url.searchParams.get("session") ?? "default";

    if (url.pathname === "/start" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        text?: string;
        withTool?: boolean;
        persist?: boolean;
        provider?: "faux" | "workers-ai";
      };
      const agent = await stub(env, session);
      // Fire-and-forget: the turn streams for several seconds so the test can
      // SIGKILL mid-stream. Do NOT await (the request would otherwise hang).
      void agent.startTurn(body.text ?? "hello tanstack", {
        withTool: body.withTool,
        persist: body.persist,
        provider: body.provider
      });
      return Response.json({ started: true });
    }

    if (url.pathname === "/status") {
      const agent = await stub(env, session);
      return Response.json(await agent.getStatus());
    }

    // WebSocket connects + agent RPC route to the DO.
    return (
      (await routeAgentRequest(request, env)) ??
      new Response(
        "tanstack-recovery: POST /start | GET /status | WS /agents/*",
        {
          status: 404
        }
      )
    );
  }
};
