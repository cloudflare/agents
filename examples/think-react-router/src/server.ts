import { createRequestHandler } from "react-router";
import type { ThinkAppContext } from "@cloudflare/think/server-entry";
import type { ServerBuild } from "react-router";

const reactRouterHandler = createRequestHandler(
  () =>
    import("virtual:react-router/server-build").then(
      (mod) => (mod.default ?? mod) as ServerBuild
    ),
  import.meta.env.MODE
);

export default {
  async fetch(
    request: Request,
    env: Cloudflare.Env,
    ctx: ExecutionContext,
    _think?: ThinkAppContext
  ) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/agents/")) {
      return null;
    }

    return reactRouterHandler(request, {
      cloudflare: {
        env,
        ctx
      }
    });
  }
};
