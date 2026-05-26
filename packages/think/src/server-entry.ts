import { camelCaseToKebabCase, routeAgentRequest } from "agents";
import type { ThinkFrameworkManifest } from "./framework/manifest";

export interface ThinkWorkerEntry {
  fetch(
    request: Request,
    env: Cloudflare.Env,
    ctx: ExecutionContext,
    think?: ThinkAppContext
  ): Response | null | Promise<Response | null>;
}

export interface ThinkAppContext {
  router: ThinkRouter;
}

export interface ThinkWorkerEntryOptions {
  fetch?: ThinkWorkerEntry["fetch"];
  thinkFirst?: boolean;
  routePrefix?: string;
  manifest?: Pick<ThinkFrameworkManifest, "agents">;
}

export interface ThinkRouteOptions {
  routePrefix?: string;
  manifest?: Pick<ThinkFrameworkManifest, "agents">;
}

export interface ThinkSubAgentRewriteOptions {
  manifest: Pick<ThinkFrameworkManifest, "agents">;
  parent?: string;
}

export interface ThinkRouterOptions extends ThinkRouteOptions {
  routePrefix?: string;
  manifest: Pick<ThinkFrameworkManifest, "agents">;
}

export interface ThinkRouteSubAgentOptions {
  parent: string;
}

interface FetchableParent {
  fetch(request: Request): Response | Promise<Response>;
}

interface SubAgentRewriteResult {
  request: Request;
  changed: boolean;
  unresolved: boolean;
}

export interface ThinkSubAgentRouteSegment {
  agent: string;
  name: string;
}

export interface ThinkAgentRoute {
  agent: string;
  name: string;
  sub?: ThinkSubAgentRouteSegment[];
}

export async function routeThinkRequest(
  request: Request,
  env: Cloudflare.Env,
  _ctx?: ExecutionContext,
  options: ThinkRouteOptions = {}
): Promise<Response | null> {
  const routedRequest = rewriteThinkAgentRequest(request, options);
  const routedEnv = options.manifest
    ? createThinkRoutingEnv(env, options.manifest)
    : env;
  return (await routeAgentRequest(routedRequest, routedEnv)) ?? null;
}

export interface ThinkRouter {
  buildPath(route: ThinkAgentRoute): string;
  parsePath(pathname: string): ThinkAgentRoute | null;
  rewriteSubAgentRequest(
    request: Request,
    options: ThinkRouteSubAgentOptions
  ): Request;
  route(
    request: Request,
    env: Cloudflare.Env,
    ctx?: ExecutionContext
  ): Promise<Response | null>;
  routeSubAgent(
    request: Request,
    parent: FetchableParent,
    options: ThinkRouteSubAgentOptions
  ): Promise<Response>;
}

export function createThinkRouter(options: ThinkRouterOptions): ThinkRouter {
  return {
    buildPath(route) {
      return buildThinkAgentPath(route, options);
    },
    parsePath(pathname) {
      return parseThinkAgentPath(pathname, options);
    },
    rewriteSubAgentRequest(request, rewriteOptions) {
      return rewriteThinkSubAgentRequest(request, {
        manifest: options.manifest,
        parent: rewriteOptions.parent
      });
    },
    route(request, env, ctx) {
      return routeThinkRequest(request, env, ctx, options);
    },
    async routeSubAgent(request, parent, routeOptions) {
      const routed = rewriteThinkSubAgentRequestResult(request, {
        manifest: options.manifest,
        parent: routeOptions.parent
      });
      if (routed.unresolved) {
        return new Response(
          `Sub-agent route not found for parent "${routeOptions.parent}".`,
          { status: 404 }
        );
      }
      return parent.fetch(routed.request);
    }
  };
}

export function createThinkWorkerEntry(
  options: ThinkWorkerEntryOptions = {}
): ThinkWorkerEntry {
  const router = options.manifest
    ? createThinkRouter({
        routePrefix: options.routePrefix,
        manifest: options.manifest
      })
    : null;
  return {
    async fetch(request, env, ctx) {
      if (options.thinkFirst) {
        const thinkResponse =
          router === null
            ? await routeThinkRequest(request, env, ctx, {
                routePrefix: options.routePrefix,
                manifest: options.manifest
              })
            : await router.route(request, env, ctx);
        if (thinkResponse) return thinkResponse;
      }

      if (options.fetch) {
        const response = await options.fetch(
          request,
          env,
          ctx,
          router ? { router } : undefined
        );
        if (response) return response;
      }

      return (
        (router === null
          ? await routeThinkRequest(request, env, ctx, {
              routePrefix: options.routePrefix,
              manifest: options.manifest
            })
          : await router.route(request, env, ctx)) ??
        new Response("Not found", { status: 404 })
      );
    }
  };
}

export function resolveThinkAgentName(
  manifest: Pick<ThinkFrameworkManifest, "agents">,
  name: string
): string {
  return resolveThinkName(manifest, name) ?? name;
}

export function resolveThinkSubAgentName(
  manifest: Pick<ThinkFrameworkManifest, "agents">,
  parent: string,
  name: string
): string {
  return resolveThinkSubAgent(manifest, parent, name)?.className ?? name;
}

export function buildThinkAgentPath(
  route: ThinkAgentRoute,
  options: ThinkRouteOptions = {}
): string {
  const prefix = normalizeRoutePrefix(options.routePrefix);
  const topLevelAgent = options.manifest
    ? resolveThinkTopLevelAgent(options.manifest, route.agent)
    : undefined;
  const agent = topLevelAgent
    ? (resolveThinkRouteAlias(options.manifest!, route.agent) ?? route.agent)
    : route.agent;
  const parts = [
    prefix,
    encodeURIComponent(agent),
    encodeURIComponent(route.name)
  ];

  let parentId = topLevelAgent?.id ?? route.agent;
  for (const subagent of route.sub ?? []) {
    const resolved =
      options.manifest && parentId
        ? resolveThinkSubAgent(options.manifest, parentId, subagent.agent)
        : undefined;
    const subagentName = resolved
      ? (resolveThinkSubAgentRouteAlias(
          options.manifest!,
          parentId,
          subagent.agent
        ) ?? subagent.agent)
      : subagent.agent;
    parts.push(
      "sub",
      encodeURIComponent(toRouteAlias(subagentName)),
      encodeURIComponent(subagent.name)
    );
    parentId = resolved?.id ?? subagent.agent;
  }

  return parts.join("/");
}

export function parseThinkAgentPath(
  pathname: string,
  options: ThinkRouteOptions = {}
): ThinkAgentRoute | null {
  const prefix = normalizeRoutePrefix(options.routePrefix);
  const pathParts = pathname.split("/").filter(Boolean);
  const prefixParts = prefix.split("/").filter(Boolean);
  if (!prefixParts.every((part, index) => pathParts[index] === part)) {
    return null;
  }

  const parts = pathParts.slice(prefixParts.length).map(decodeURIComponent);
  const [agent, name, ...rest] = parts;
  if (!agent || !name) return null;

  const sub: ThinkSubAgentRouteSegment[] = [];
  for (let index = 0; index < rest.length; index += 3) {
    if (rest[index] !== "sub") return null;
    const subAgent = rest[index + 1];
    const subName = rest[index + 2];
    if (!subAgent || !subName) return null;
    sub.push({ agent: subAgent, name: subName });
  }

  return { agent, name, sub: sub.length ? sub : undefined };
}

export function rewriteThinkSubAgentRequest(
  request: Request,
  options: ThinkSubAgentRewriteOptions
): Request {
  return rewriteThinkSubAgentRequestResult(request, options).request;
}

function rewriteThinkSubAgentRequestResult(
  request: Request,
  options: ThinkSubAgentRewriteOptions
): SubAgentRewriteResult {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  let parentId = options.parent ?? onlyTopLevelAgent(options.manifest)?.id;
  if (!parentId) {
    return {
      request,
      changed: false,
      unresolved: requestHasSubAgentSegment(request)
    };
  }

  const rewritten = rewriteSubAgentParts(parts, 0, options.manifest, parentId);

  if (!rewritten.changed) {
    return {
      request,
      changed: false,
      unresolved: rewritten.unresolved
    };
  }
  url.pathname = `/${parts.join("/")}`;
  return {
    request: new Request(url, request),
    changed: true,
    unresolved: rewritten.unresolved
  };
}

function resolveThinkName(
  manifest: Pick<ThinkFrameworkManifest, "agents">,
  name: string
): string | undefined {
  return manifest.agents.find(
    (agent) => agent.className === name || agent.aliases.includes(name)
  )?.className;
}

function rewriteThinkAgentRequest(
  request: Request,
  options: ThinkRouteOptions
): Request {
  const url = new URL(request.url);
  const rewritten = rewriteThinkAgentPathname(url.pathname, options);
  if (!rewritten) return request;
  url.pathname = rewritten;
  return new Request(url, request);
}

function rewriteThinkAgentPathname(
  pathname: string,
  options: ThinkRouteOptions
): string | null {
  const routePrefix = normalizeRoutePrefix(options.routePrefix);
  const pathParts = pathname.split("/").filter(Boolean);
  const prefixParts = routePrefix.split("/").filter(Boolean);
  if (!prefixParts.every((part, index) => pathParts[index] === part)) {
    return null;
  }

  const agentIndex = prefixParts.length;
  const agentSegment = pathParts[agentIndex];
  const nameSegment = pathParts[agentIndex + 1];
  if (!agentSegment || !nameSegment) return null;

  let parentId: string | undefined;
  if (options.manifest) {
    const topLevel = resolveThinkTopLevelAgent(options.manifest, agentSegment);
    if (topLevel) {
      pathParts[agentIndex] =
        resolveThinkRouteAlias(options.manifest, agentSegment) ?? agentSegment;
      parentId = topLevel.id;
    }
  }

  if (parentId && options.manifest) {
    const rewritten = rewriteSubAgentParts(
      pathParts,
      agentIndex + 2,
      options.manifest,
      parentId
    );
    if (rewritten.unresolved) return null;
  }

  return `/${["agents", ...pathParts.slice(agentIndex)].join("/")}`;
}

function rewriteSubAgentParts(
  parts: string[],
  startIndex: number,
  manifest: Pick<ThinkFrameworkManifest, "agents">,
  initialParentId: string
): { changed: boolean; unresolved: boolean } {
  let changed = false;
  let unresolved = false;
  let parentId = initialParentId;
  for (let index = startIndex; index < parts.length; index++) {
    if (parts[index] !== "sub") continue;
    const childSegment = parts[index + 1];
    if (!childSegment) {
      unresolved = true;
      continue;
    }
    const resolved = resolveThinkSubAgent(manifest, parentId, childSegment);
    if (!resolved) {
      unresolved = true;
      continue;
    }
    parts[index + 1] = toAgentsClassSegment(resolved.className);
    parentId = resolved.id;
    changed = true;
    index += 2;
  }
  return { changed, unresolved };
}

function resolveThinkRouteAlias(
  manifest: Pick<ThinkFrameworkManifest, "agents">,
  name: string
): string | undefined {
  const match = resolveThinkTopLevelAgent(manifest, name);
  return match?.id ?? match?.aliases[0];
}

function resolveThinkTopLevelAgent(
  manifest: Pick<ThinkFrameworkManifest, "agents">,
  name: string
) {
  const resolved = resolveThinkName(manifest, name);
  return manifest.agents.find(
    (agent) =>
      agent.kind === "top-level" &&
      (agent.id === name ||
        agent.bindingName === name ||
        agent.className === name ||
        agent.aliases.includes(name) ||
        resolved === agent.className)
  );
}

function onlyTopLevelAgent(manifest: Pick<ThinkFrameworkManifest, "agents">) {
  const topLevel = manifest.agents.filter(
    (agent) => agent.kind === "top-level"
  );
  return topLevel.length === 1 ? topLevel[0] : undefined;
}

function resolveThinkSubAgent(
  manifest: Pick<ThinkFrameworkManifest, "agents">,
  parent: string,
  name: string
) {
  const parentAgent = resolveThinkTopLevelAgent(manifest, parent);
  const parentId = parentAgent?.id ?? parent;
  return manifest.agents.find(
    (agent) =>
      agent.parentId === parentId &&
      (agent.id === `${parentId}/${name}` ||
        agent.className === name ||
        agent.aliases.includes(name))
  );
}

function resolveThinkSubAgentRouteAlias(
  manifest: Pick<ThinkFrameworkManifest, "agents">,
  parent: string,
  name: string
): string | undefined {
  const match = resolveThinkSubAgent(manifest, parent, name);
  return match?.aliases.find((alias) => !alias.includes("/")) ?? match?.id;
}

function createThinkRoutingEnv(
  env: Cloudflare.Env,
  manifest: Pick<ThinkFrameworkManifest, "agents">
): Cloudflare.Env {
  const target = env as unknown as Record<string | symbol, unknown>;
  const aliases = new Map<string, string>();
  for (const agent of manifest.agents) {
    if (agent.kind !== "top-level") continue;
    const routeKeys = new Set(
      [
        pascalCase(agent.id),
        agent.bindingName,
        ...agent.aliases.filter(isIdentifier)
      ].filter((key): key is string => typeof key === "string")
    );
    for (const key of routeKeys) {
      aliases.set(key, agent.bindingName ?? agent.className);
    }
  }

  return new Proxy(target, {
    get(current, property, receiver) {
      const resolved =
        typeof property === "string"
          ? (aliases.get(property) ?? property)
          : property;
      return Reflect.get(current, resolved, receiver);
    },
    has(current, property) {
      return (
        (typeof property === "string" && aliases.has(property)) ||
        Reflect.has(current, property)
      );
    },
    ownKeys(current) {
      return [...new Set([...Reflect.ownKeys(current), ...aliases.keys()])];
    },
    getOwnPropertyDescriptor(current, property) {
      const resolved =
        typeof property === "string"
          ? (aliases.get(property) ?? property)
          : property;
      const descriptor = Reflect.getOwnPropertyDescriptor(current, resolved);
      if (!descriptor) return undefined;
      return { ...descriptor, configurable: true };
    }
  }) as unknown as Cloudflare.Env;
}

function routePrefixToAgentsPrefix(routePrefix = "/agents"): string {
  return routePrefix.replace(/^\/+|\/+$/g, "") || "agents";
}

function normalizeRoutePrefix(routePrefix = "/agents"): string {
  return `/${routePrefixToAgentsPrefix(routePrefix)}`;
}

function toRouteAlias(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function toAgentsClassSegment(name: string): string {
  return camelCaseToKebabCase(name);
}

function requestHasSubAgentSegment(request: Request): boolean {
  return new URL(request.url).pathname.split("/").includes("sub");
}

function pascalCase(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function isIdentifier(value: string): boolean {
  return /^[$A-Z_a-z][$\w]*$/.test(value);
}
