// The hope is that you only have to write the following
`
import { createAgentThread } from "./worker";
import { createHandler } from "./handler";

const AgentThread = createAgentThread({
  provider: makeOpenAI(env.OPENAI_API_KEY, env.OPENAI_BASE_URL),
});

export AgentThread;
export default createHandler(); // this is the entrypoint to the worker
`;

export const createHandler = (_opts: { baseUrl?: string }) => {
  return {
    async fetch(
      req: Request,
      env: { AGENT_THREAD: DurableObjectNamespace },
      _ctx: ExecutionContext
    ) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/threads") {
        const id = crypto.randomUUID();
        return new Response(JSON.stringify({ id }), { status: 201 });
      }

      if (req.method === "GET" && url.pathname === "/dashboard") {
        // TODO: We must expose a nice dashboard here to use all of this.
        // We want this library to be usable out of the box.
        return new Response("Not implemented", {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }

      const match = url.pathname.match(/^\/threads\/([^/]+)(?:\/(.*))?$/);
      if (!match) return new Response("not found", { status: 404 });
      const [_, threadId, tail] = match;

      const stub = env.AGENT_THREAD.get(env.AGENT_THREAD.idFromName(threadId));

      // We rather do everything through WS, so we don't need to handle SSE here
      if (tail === "invoke") return stub.fetch(req);
      if (tail === "approve") return stub.fetch(req);
      if (tail === "state") return stub.fetch(req);
      if (tail === "ws" && req.headers.get("upgrade") === "websocket")
        return stub.fetch(req); // DO handles WS accept

      return new Response("not found", { status: 404 });
    }
  };
};
