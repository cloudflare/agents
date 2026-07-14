/**
 * Fixture worker for ported original tests (audit 29). Fixture agent classes
 * live in ./fixtures/ — re-authored against the rebuilt public API, one per
 * ported test file (or shared where the original shared them). Binding names
 * in wrangler.jsonc mirror the ORIGINAL test wrangler config so ported test
 * files keep their `env.<BINDING>` references unchanged.
 */
import { routeAgentRequest } from "../../src/adapters/cloudflare/routing.js";

export * from "./fixtures/index.js";

export default {
  async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    return (await routeAgentRequest(request, env)) ?? new Response(null, { status: 404 });
  },
};
