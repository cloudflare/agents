import {
  ChannelGateway,
  type GatewayAgent
} from "agents/experimental/channels";

export { AiSdkAgent } from "./ai-sdk-agent";
export { PiAgent } from "./pi/agent";

/** Each harness's agents, by the first segment of a route. */
const harnesses: Record<string, (env: Env, name: string) => GatewayAgent> = {
  "ai-sdk": (env, name) => env.AiSdkAgent.getByName(name),
  pi: (env, name) => env.PiAgent.getByName(name)
};

/**
 * A route is `<harness>/<room>`: `/channels/ai-sdk/lobby` reaches the
 * AiSdkAgent named `lobby`. The gateway hands routes back to `agent`, which
 * picks the namespace.
 */
function gatewayFor(env: Env) {
  return new ChannelGateway({
    channels: {},
    agent: (route) => {
      const slash = route.indexOf("/");
      return harnesses[route.slice(0, slash)](env, route.slice(slash + 1));
    },
    // Demo only: the client names itself with `?as=`. A real app resolves
    // the participant from a session it can verify.
    web: (request) => {
      const url = new URL(request.url);
      const match = /^\/channels\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(
        url.pathname
      );
      if (!match || !Object.hasOwn(harnesses, match[1])) return undefined;
      return {
        route: `${match[1]}/${decodeURIComponent(match[2])}`,
        ...(match[3] && { conversationId: decodeURIComponent(match[3]) }),
        participant: { id: url.searchParams.get("as") ?? "anonymous" }
      };
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
