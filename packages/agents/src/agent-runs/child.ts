/**
 * How a parent reaches the child of an agent-tool run.
 *
 * The child is an ordinary named Durable Object: the namespace of its
 * exported class, under a name the parent mints when it records the run
 * (or the caller's `childName`). Clients drill in through the parent (see
 * {@link forwardAgentToolRunRequest}); the child class is a declared
 * Durable Object, so the Worker's routing can reach it by name too.
 */

import { getAgentByName } from "../agent-routing";
import type { Agent } from "../index";

/**
 * @internal A typed stub for the child of a run: the child class's own methods
 * (not `Agent`'s), each returning a Promise. Return values cross a Durable
 * Object RPC call, so they must be serializable.
 */
export type AgentToolChildStub<T extends Agent> = {
  [
    K in keyof T as K extends keyof Agent
      ? never
      : T[K] extends (...args: never[]) => unknown
        ? K
        : never
  ]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => R extends Promise<unknown> ? R : Promise<R>
    : never;
};

/** @internal The URL segment a parent forwards to a run's child: `/agent-tool-runs/{runId}`. */
export const AGENT_TOOL_RUN_ROUTE = "agent-tool-runs";

/** The `ctx.exports` entry for a class: a namespace when the class is a Durable Object. */
type ExportsCtx = {
  exports?: Record<
    string,
    Partial<Pick<DurableObjectNamespace, "idFromName" | "get">> | undefined
  >;
};

/** @internal The namespace of an exported Durable Object class, or an error saying what is missing. */
export function agentToolChildNamespace(
  ctx: DurableObjectState,
  className: string
): DurableObjectNamespace<Agent> {
  const entry = (ctx as unknown as ExportsCtx).exports?.[className];
  if (
    !entry ||
    typeof entry.idFromName !== "function" ||
    typeof entry.get !== "function"
  ) {
    throw new Error(
      `Agent tool child "${className}" is not a Durable Object namespace in ctx.exports. Export the class from your Worker and declare it under durable_objects.bindings and migrations (new_sqlite_classes) in wrangler.jsonc.`
    );
  }
  return entry as unknown as DurableObjectNamespace<Agent>;
}

/** @internal The started child of a run, as a stub. */
export function agentToolChildStub(
  ctx: DurableObjectState,
  className: string,
  childName: string
): Promise<DurableObjectStub<Agent>> {
  return getAgentByName<Cloudflare.Env, Agent>(
    agentToolChildNamespace(ctx, className),
    childName
  );
}

/**
 * @internal Every reading of a request as `/agent-tool-runs/{runId}/...`: the
 * run id and the path the child sees. The segment can also be part of the
 * agent's own name, so each occurrence is a candidate.
 */
export function matchAgentToolRunRequest(
  request: Request
): Array<{ runId: string; url: URL }> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/");
  const matches: Array<{ runId: string; url: URL }> = [];
  for (let i = 1; i < segments.length - 1; i++) {
    if (segments[i] !== AGENT_TOOL_RUN_ROUTE || segments[i + 1] === "") {
      continue;
    }
    let runId = segments[i + 1];
    try {
      runId = decodeURIComponent(runId);
    } catch {
      // Keep the raw segment.
    }
    const target = new URL(url);
    target.pathname = `/${segments.slice(i + 2).join("/")}`;
    matches.push({ runId, url: target });
  }
  return matches;
}

/**
 * @internal Where a run's child is, for a drill-in: its class and name;
 * `"facet-era"` for a run from when children were facets, whose child cannot
 * be opened; `"never-started"` for a run refused at dispatch, which has no
 * child; or `null` when the parent has no such run.
 */
export type AgentToolRunChildAddress =
  | { className: string; childName: string }
  | "facet-era"
  | "never-started"
  | null;

const UNREACHABLE_CHILD = {
  "facet-era":
    "This agent tool run's child was kept by an earlier version and cannot be opened",
  "never-started": "This agent tool run never started, so it has no child"
} as const;

/**
 * @internal Forward a request (HTTP or WebSocket upgrade) to a run's child. After an
 * upgrade the child owns the socket, so its frames never wake the parent.
 *
 * @param child - Where the child of a run id is.
 * @returns The child's response for the first candidate that names a run
 *   with a child; else `404` when a candidate names a run whose child cannot
 *   be opened, so the request never lands on the parent's own chat; else
 *   `undefined`, so the agent handles the request itself.
 */
export async function forwardAgentToolRunRequest(
  ctx: DurableObjectState,
  request: Request,
  child: (runId: string) => AgentToolRunChildAddress
): Promise<Response | undefined> {
  let unreachable: "facet-era" | "never-started" | undefined;
  for (const match of matchAgentToolRunRequest(request)) {
    const target = child(match.runId);
    if (!target) continue;
    if (typeof target === "string") {
      unreachable ??= target;
      continue;
    }
    const stub = await agentToolChildStub(
      ctx,
      target.className,
      target.childName
    );
    return stub.fetch(new Request(match.url, request));
  }
  if (unreachable) {
    return new Response(UNREACHABLE_CHILD[unreachable], { status: 404 });
  }
  // No candidate is a run: the segment belongs to the agent's own name or
  // one of its own routes, so the request is the agent's.
  return undefined;
}
