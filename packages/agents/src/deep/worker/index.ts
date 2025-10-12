import { getAgentByName, type Agent } from "../..";
import { html } from "./client";

type HandlerOpions = {
  baseUrl?: string;
  /** Secret to use for authorization. Optional means no check. */
  secret?: string;
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
export const createHandler = (
  opts: { baseUrl?: string; secret?: string } = {}
) => {
  return {
    async fetch(
      req: Request,
      env: { DEEP_AGENT: DurableObjectNamespace<Agent> },
      _ctx: ExecutionContext
    ) {
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

      if (req.method === "POST" && url.pathname === "/threads") {
        const id = crypto.randomUUID();
        return new Response(JSON.stringify({ id }), { status: 201 });
      }

      const match = url.pathname.match(/^\/threads\/([^/]+)(?:\/(.*))?$/);
      if (!match) return new Response("not found", { status: 404 });
      const [_, threadId, tail] = match;
      const stub = await getAgentByName(env.DEEP_AGENT, threadId);

      // Create a new request with the path that the DO expects
      const doUrl = new URL(req.url);
      doUrl.pathname = `/${tail || ""}`;

      // For invoke requests, inject thread_id into the body
      let doReq: Request;
      if (tail === "invoke" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        body.thread_id = threadId;
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
