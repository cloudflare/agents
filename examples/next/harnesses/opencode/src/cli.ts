/**
 * The OpenCode CLI, which the Pi example has no counterpart for.
 *
 * The CLI speaks OpenCode's HTTP API, and `harness.fetch()` serves it. Point
 * the CLI at one object's URL, and it puts OpenCode's paths under it:
 *
 * ```sh
 * npx @opencode/cli@2 --server http://localhost:5173/agents/open-code-agent/<name>
 * ```
 *
 * `routeAgentRequest` sends `/agents/open-code-agent/<name>/api/...` to that
 * object, whose `onRequest` hands it here.
 */

/** `/agents/<class>/<name>`, the prefix `routeAgentRequest` routes on. */
const AGENT_PREFIX = /^\/agents\/[^/]+\/[^/]+/;

/** The request with OpenCode's own path, as `harness.fetch()` takes it. */
export function openCodeRequest(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(AGENT_PREFIX, "") || "/";
  return new Request(url, request);
}
