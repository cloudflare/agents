import handler from "@tanstack/react-start/server-entry";
import type { ThinkAppContext } from "@cloudflare/think/server-entry";
import type { Env } from "./env";

export default {
  async fetch(
    request: Request,
    _env: Env,
    _ctx: ExecutionContext,
    _think?: ThinkAppContext
  ) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/agents/")) {
      return null;
    }

    return handler.fetch(request);
  }
};
