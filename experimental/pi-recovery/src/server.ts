/**
 * pi-recovery worker entry.
 *
 * A small HTTP control surface (no WebSocket) routes to the `PiAgent` Durable
 * Object stub so the SIGKILL e2e can: start a turn, kill `wrangler dev`
 * mid-stream, restart, and poll recovery status. See `pi-agent.ts`.
 *
 * @internal Validation fixture, not a published package.
 */
import { getAgentByName } from "agents";
import { PiAgent } from "./pi-agent";

export { PiAgent };

async function stub(env: Env, session: string) {
  return getAgentByName(env.PiAgent, session);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const session = url.searchParams.get("session") ?? "default";

    if (url.pathname === "/pi/start" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        text?: string;
      };
      const agent = await stub(env, session);
      // Fire-and-forget: the turn streams for several seconds so the test can
      // SIGKILL mid-stream. Do NOT await (the request would otherwise hang).
      void agent.startTurn(body.text ?? "hello pi");
      return Response.json({ started: true });
    }

    if (url.pathname === "/pi/status") {
      const agent = await stub(env, session);
      return Response.json(await agent.getStatus());
    }

    return new Response("pi-recovery: POST /pi/start | GET /pi/status", {
      status: 404
    });
  }
};
