import {
  ChannelGateway,
  type GatewayAgent
} from "agents/experimental/channels";
import { web } from "agents/experimental/channels/web";

export { ThinkAgent } from "./think-agent";
export { PiAgent } from "./pi/agent";

/** Each harness's agents, by the first segment of a route. */
const harnesses: Record<string, (env: Env, name: string) => GatewayAgent> = {
  think: (env, name) => env.ThinkAgent.getByName(name),
  pi: (env, name) => env.PiAgent.getByName(name)
};

/**
 * `/channels/<harness>/<room>[/<conversation>]`: `/channels/think/lobby`
 * reaches the ThinkAgent named `lobby`.
 */
function parse(request: Request) {
  const match = /^\/channels\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(
    new URL(request.url).pathname
  );
  if (!match || !Object.hasOwn(harnesses, match[1])) return undefined;
  return {
    route: `${match[1]}/${decodeURIComponent(match[2])}`,
    conversationId: match[3] && decodeURIComponent(match[3])
  };
}

function gatewayFor(env: Env) {
  return new ChannelGateway({
    agent: (route) => {
      const slash = route.indexOf("/");
      return harnesses[route.slice(0, slash)](env, route.slice(slash + 1));
    },
    channels: {
      web: web({
        match: (request) => {
          const parsed = parse(request);
          if (!parsed) return undefined;
          return parsed.conversationId
            ? { conversationId: parsed.conversationId }
            : {};
        },
        // Demo only: the client names itself with `?as=`. A real app
        // resolves the participant from a session it can verify.
        participant: (request) =>
          new URL(request.url).searchParams.get("as") ?? crypto.randomUUID(),
        // Demo only: anyone may join any room. The agent object is the
        // authorization boundary, so a real app checks that the
        // participant may enter the room, or leaves out `route` to give
        // each participant a room of their own.
        route: (request) => parse(request)?.route ?? null
      })
    }
  });
}

export default {
  async fetch(request, env) {
    return (
      (await gatewayFor(env).fetch(request)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
