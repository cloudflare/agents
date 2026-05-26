import { getAgentByName, type Agent } from "agents";
import type { ThinkAppContext } from "../../../../server-entry";

export default {
  async fetch(
    request: Request,
    env: Cloudflare.Env,
    _ctx: ExecutionContext,
    think?: ThinkAppContext
  ) {
    const url = new URL(request.url);
    if (url.pathname === "/app") {
      return new Response("app route");
    }
    if (url.pathname.startsWith("/custom-gated/support/")) {
      const parent = await getAgentByName(
        Reflect.get(env, "SupportDirectory") as DurableObjectNamespace<
          Agent & { ensureResearcher(name: string): Promise<void> }
        >,
        "custom-gated-parent"
      );
      await parent.ensureResearcher("gated-child");
      return think?.router.routeSubAgent(request, parent, {
        parent: "support"
      });
    }
    if (url.pathname.startsWith("/custom/support/")) {
      const parent = await getAgentByName(
        Reflect.get(env, "SupportDirectory") as DurableObjectNamespace<Agent>,
        "custom-parent"
      );
      return think?.router.routeSubAgent(request, parent, {
        parent: "support"
      });
    }
    return null;
  }
};
