/**
 * Test worker for the assistant example.
 *
 * This worker is **not** the production worker. It re-exports the
 * production `AssistantDirectory` and `MyAssistant` classes verbatim
 * (so the harness exercises real code, not a fork) but replaces the
 * surrounding plumbing:
 *
 *   - GitHub OAuth gating is dropped entirely. The production worker's
 *     responsibility is to authenticate the user and forward `/chat*`
 *     into the right `AssistantDirectory`. That's a Worker concern, not
 *     a multi-session-correctness concern, so the test worker uses a
 *     bare `routeAgentRequest` so tests can address directories by name
 *     directly.
 *
 *   - `worker_loaders` is bound (`LOADER`) because `MyAssistant` reads
 *     `this.env.LOADER` as a class field at construction. We never
 *     actually load extensions in tests, but the binding has to exist.
 *
 * No AI binding is declared. Tests deliberately don't trigger turns —
 * `MyAssistant.getModel()` is never called. That means we don't have
 * to mock Workers AI or worry about `kimi-k2.6` flakiness, and the
 * harness focuses on the plumbing the example owns: directory CRUD,
 * `SharedWorkspace` round-trips, change broadcasts, and the MCP
 * empty-state path. See `shared-mcp.test.ts` for why the deep MCP
 * round-trip is out of scope here.
 */

import { routeAgentRequest } from "agents";

export { AssistantDirectory, MyAssistant } from "../server";

import type { AssistantDirectory, MyAssistant } from "../server";

export type Env = {
  AssistantDirectory: DurableObjectNamespace<AssistantDirectory>;
  MyAssistant: DurableObjectNamespace<MyAssistant>;
  LOADER: WorkerLoader;
};

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env, { cors: true })) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
