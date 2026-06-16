import { getAgentByName } from "agents";

/**
 * Custom Worker entry that runs in front of the generated Think router.
 *
 * The Think framework discovers `src/server.ts` and calls `fetch` first; return
 * a `Response` to handle the request, or `undefined` to fall through to the
 * Think router (which serves the chat WebSocket, assets, and `/agents/*`).
 *
 * Here we expose `POST /webhook`: it durably hands the event to the agent and
 * returns immediately. `submitMessages({ idempotencyKey })` is the key — the
 * webhook can time out or retry without ever duplicating work.
 */
export default {
  async fetch(
    request: Request,
    env: Cloudflare.Env,
    _ctx: ExecutionContext
  ): Promise<Response | undefined> {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      const event = (await request.json().catch(() => null)) as {
        id?: string;
        type?: string;
        [key: string]: unknown;
      } | null;

      if (!event || typeof event.id !== "string") {
        return Response.json(
          { error: "Webhook payload must be JSON with a string `id`." },
          { status: 400 }
        );
      }

      // One durable agent per source stream. Swap `"default"` for a tenant,
      // account, or repository id to fan out to per-entity agents.
      const agent = await getAgentByName(env.ThinkAgent_Inbox, "default");
      const receipt = await agent.ingestEvent(event.id, event);
      return Response.json(receipt);
    }

    // Fall through to the Think router.
    return undefined;
  }
};
