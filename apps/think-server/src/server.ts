/**
 * think-server — Remote coding agent powered by Think.
 *
 * Standard agents SDK routing. Clients connect via WebSocket
 * to /agents/think-server/<session-id>.
 */

import { routeAgentRequest } from "agents";
import { ThinkServer } from "./agent";
import { GatedFetchEntrypoint } from "./gated-fetch";

export { ThinkServer, GatedFetchEntrypoint };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
