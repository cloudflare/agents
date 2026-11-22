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
 * @internal The run a request addresses as `/agent-tool-runs/{runId}/...`,
 * and the path the child sees, or `null`. The route segment is the one right
 * after the agent's own name, so a name or a child path that contains the
 * segment is not read as a run. Without the name in the path (a custom base
 * path), the first occurrence counts.
 */
export function matchAgentToolRunRequest(
  request: Request,
  agentName?: string
): { runId: string; url: URL } | null {
  const url = new URL(request.url);
  const segments = url.pathname.split("/");
  const decode = (segment: string) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  };
  let first: number | undefined;
  let anchored: number | undefined;
  for (let i = 1; i < segments.length - 1; i++) {
    if (segments[i] !== AGENT_TOOL_RUN_ROUTE || segments[i + 1] === "") {
      continue;
    }
    first ??= i;
    if (agentName !== undefined && decode(segments[i - 1]) === agentName) {
      anchored = i;
      break;
    }
  }
  const at = anchored ?? first;
  if (at === undefined) return null;
  const target = new URL(url);
  target.pathname = `/${segments.slice(at + 2).join("/")}`;
  return { runId: decode(segments[at + 1]), url: target };
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
 * @param agentName - The agent's own name, to find the route segment after it.
 * @returns The child's response; `404` for a run whose child cannot be
 *   opened, so the request never lands on the parent's own chat; or
 *   `undefined` when the path names no run of this parent, so the agent
 *   handles the request itself.
 */
export async function forwardAgentToolRunRequest(
  ctx: DurableObjectState,
  request: Request,
  child: (runId: string) => AgentToolRunChildAddress,
  agentName?: string
): Promise<Response | undefined> {
  const match = matchAgentToolRunRequest(request, agentName);
  if (!match) return undefined;
  const target = child(match.runId);
  if (typeof target === "string") {
    return new Response(UNREACHABLE_CHILD[target], { status: 404 });
  }
  if (target) {
    const stub = await agentToolChildStub(
      ctx,
      target.className,
      target.childName
    );
    return stub.fetch(new Request(match.url, request));
  }
  // Not a run of this parent: the segment belongs to one of the agent's own
  // routes, so the request is the agent's.
  return undefined;
}
