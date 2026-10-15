/**
 * Internal hostnames: sites only this agent's browser can open.
 *
 * A host maps a hostname such as `preview.internal` to code in your agent
 * (`fetch`) or to a deployed Worker (`fetcher`). Browser Run sends the
 * browser's requests for that hostname to it instead of the internet, so a
 * page can be served from a sandbox port or a workspace folder, without exposing anything publicly.
 *
 * How a request travels: Browser Run accepts only entrypoints of your own
 * Worker as routes, and keeps them for the whole browser session, across
 * redeploys. So every `fetch` host routes to {@link InternalHostRouter}, which
 * you export from your main module. Its props say which agent and browser
 * own the host, and nothing else. It calls the agent's `fetchInternalHost()`
 * over RPC, and the agent's `Browser` runs the host's `fetch`. `Agent` has
 * that method built in; a plain Durable Object adds it (see
 * {@link InternalHostMessage}). A `fetcher` host goes straight to the Worker
 * you gave it.
 */

import { WorkerEntrypoint } from "cloudflare:workers";

/** The most hostnames one browser can have. A Browser Run limit. */
export const MAX_INTERNAL_HOSTS = 8;

// ── Hosts ──────────────────────────────────────────────────────────────────

/** A host served by code in your agent. */
export interface InternalHost {
  /** Shown to the model next to the hostname. */
  description?: string;
  /**
   * Serves every browser request to this hostname. Runs in your agent.
   */
  fetch: (request: Request) => Promise<Response>;
  fetcher?: never;
}

/**
 * A host served by a deployed Worker directly, without going through your
 * agent: a service binding, or `this.ctx.exports.SomeEntrypoint(...)`. Not a
 * Dynamic Worker or Durable Object stub — Browser Run can't hold those.
 */
export interface InternalFetcherHost {
  /** Shown to the model next to the hostname. */
  description?: string;
  /**
   * The Worker that serves this hostname: a service binding, or an
   * entrypoint of your own Worker (`this.ctx.exports.DocsSite`). Requests
   * go straight to it, without waking your agent.
   */
  fetcher: Fetcher;
  fetch?: never;
}

/** The entrypoint loopback for {@link InternalHostRouter}: `this.ctx.exports.InternalHostRouter`. */
export type InternalHostRouterLoopback = (init: {
  props: InternalHostRouterProps;
}) => Fetcher;

/**
 * `browserRun()`'s `internalHosts`: hostnames only this browser can open.
 *
 * Fixed when a browser starts. Adding or removing a hostname replaces the
 * browser (the model sees `restarted`); changing a host's `fetch` or
 * `description` doesn't.
 */
export interface InternalHostsOptions {
  /**
   * Your Worker's {@link InternalHostRouter} export, as
   * `this.ctx.exports.InternalHostRouter`. Needed for `fetch` hosts.
   */
  router?: InternalHostRouterLoopback;
  /**
   * At most {@link MAX_INTERNAL_HOSTS} hostnames: bare and lowercase, no
   * scheme, port, or path. Use a name that can't be a real site, like
   * `preview.internal`.
   */
  hosts: Record<string, InternalHost | InternalFetcherHost>;
}

/** Either kind of host. */
export type AnyInternalHost = InternalHost | InternalFetcherHost;

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Why `host` can't be an internal hostname, or undefined when it can. */
function hostnameProblem(host: string): string | undefined {
  if (host.includes("://")) return "drop the scheme";
  if (host.includes("/")) return "drop the path";
  if (host.includes(":")) return "drop the port (only port 80 is routed)";
  if (host !== host.toLowerCase()) return "use lowercase";
  if (/^\d+(\.\d+){3}$/.test(host)) return "use a name, not an IP address";
  if (host === "localhost") return "Chrome blocks localhost";
  if (!HOSTNAME.test(host)) return "not a valid hostname";
  return undefined;
}

/**
 * Check `internalHosts` when the provider is created, so a mistake fails at
 * startup instead of at the first browser launch.
 */
export function validateInternalHosts(options: InternalHostsOptions): void {
  const hosts = Object.entries(options.hosts) as [string, AnyInternalHost][];
  if (hosts.length === 0) {
    throw new Error("internalHosts.hosts needs at least one hostname");
  }
  if (hosts.length > MAX_INTERNAL_HOSTS) {
    throw new Error(
      `internalHosts has ${hosts.length} hostnames; Browser Run allows at most ${MAX_INTERNAL_HOSTS} per browser`
    );
  }
  for (const [host, config] of hosts) {
    const problem = hostnameProblem(host);
    if (problem) {
      throw new Error(`Internal hostname "${host}": ${problem}`);
    }
    const hasFetch = typeof config.fetch === "function";
    const hasFetcher = config.fetcher !== undefined;
    if (hasFetch === hasFetcher) {
      throw new Error(
        `Internal hostname "${host}" needs exactly one of fetch or fetcher`
      );
    }
    if (hasFetch && !options.router) {
      throw new Error(
        `Internal hostname "${host}" uses fetch, which needs internalHosts.router: this.ctx.exports.InternalHostRouter (and \`export { InternalHostRouter } from "agents/browser"\` in your main module)`
      );
    }
  }
}

/**
 * Identifies the set of hostnames and how each is routed. A browser started
 * with a different set is replaced: Browser Run fixes routes at launch.
 */
export function internalHostsSignature(
  options: InternalHostsOptions | undefined
): string | undefined {
  if (!options) return undefined;
  const hosts = Object.entries(options.hosts) as [string, AnyInternalHost][];
  return hosts
    .map(([host, config]) => `${host}=${config.fetcher ? "fetcher" : "fetch"}`)
    .sort()
    .join(",");
}

/**
 * The route Browser Run gets for a `fetcher` host. A `ctx.exports`
 * entrypoint is a loopback stub that Browser Run can't take as is, so it's
 * called (with empty props) to get a Fetcher it can.
 */
export function fetcherRoute(fetcher: Fetcher): Fetcher {
  if (typeof fetcher !== "function") return fetcher;
  const loopback = fetcher as unknown as (init: { props: object }) => Fetcher;
  return loopback({ props: {} });
}

// ── Router ─────────────────────────────────────────────────────────────────

/**
 * What {@link InternalHostRouter} is given for one hostname: which agent and
 * browser own it. Browser Run keeps these for the whole session, across
 * redeploys, so they hold names only, never secrets or config.
 */
export type InternalHostRouterProps = {
  readonly v: 1;
  /** The agent's class name, as exported from the Worker. */
  readonly className: string;
  /** The agent's name. */
  readonly name: string;
  /** The name of the `Browser` that owns the host. */
  readonly browser: string;
  /** The hostname this route serves. */
  readonly host: string;
};

/**
 * One browser request to an internal hostname, as {@link InternalHostRouter}
 * hands it to the agent's `fetchInternalHost()`.
 *
 * `Agent` has `fetchInternalHost()` built in. A plain Durable Object adds it
 * and passes the message to its `Browser`:
 *
 * ```ts
 * fetchInternalHost(message: InternalHostMessage) {
 *   return this.browser.fetchInternalHost(message);
 * }
 * ```
 */
export type InternalHostMessage = {
  /** The name of the `Browser` that owns the host. */
  readonly browser: string;
  /** The hostname, such as `preview.internal`. */
  readonly host: string;
  /** The browser's request. */
  readonly request: Request;
};

export function isInternalHostMessage(
  value: unknown
): value is InternalHostMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<InternalHostMessage>;
  return (
    typeof message.browser === "string" &&
    typeof message.host === "string" &&
    message.request instanceof Request
  );
}

/** A plain-text response the browser shows for a failed internal request. */
export function internalHostError(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" }
  });
}

/** What {@link InternalHostRouter} calls on the agent that owns a host. */
type InternalHostTarget = {
  fetchInternalHost(message: InternalHostMessage): Promise<unknown>;
};

type OwnerNamespace = {
  getByName(name: string): InternalHostTarget;
};

/** Whether an RPC call failed because the agent has no `fetchInternalHost()`. */
function isMissingMethod(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("fetchInternalHost") &&
    /does not implement|is not a function/.test(error.message)
  );
}

/**
 * Carries a browser's requests for an internal hostname to the agent that
 * owns it. Export it from your Worker's main module, so
 * `this.ctx.exports.InternalHostRouter` exists:
 *
 * ```ts
 * export { InternalHostRouter } from "agents/browser";
 * ```
 *
 * It holds no logic of its own: it calls the agent's `fetchInternalHost()`
 * with an {@link InternalHostMessage}, and the agent's `Browser` runs the
 * host's `fetch`. `Agent` has `fetchInternalHost()` built in; a plain
 * Durable Object adds it (see {@link InternalHostMessage}).
 *
 * @experimental The API may change before it stabilizes.
 */
export class InternalHostRouter extends WorkerEntrypoint<
  unknown,
  InternalHostRouterProps
> {
  override async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props;
    const exports = (
      this.ctx as unknown as { exports?: Record<string, unknown> }
    ).exports;
    const namespace = exports?.[props.className] as OwnerNamespace | undefined;
    if (!namespace?.getByName) {
      return internalHostError(
        502,
        `${props.host}: the agent class "${props.className}" isn't exported from this Worker`
      );
    }
    try {
      const response = await namespace.getByName(props.name).fetchInternalHost({
        browser: props.browser,
        host: props.host,
        request
      });
      if (response instanceof Response) return response;
      return internalHostError(
        502,
        `${props.host}: the agent didn't answer with a Response`
      );
    } catch (error) {
      if (isMissingMethod(error)) {
        return internalHostError(
          502,
          `${props.host}: ${props.className} has no fetchInternalHost() method. Agent has it built in; on a plain Durable Object add: fetchInternalHost(message) { return this.browser.fetchInternalHost(message); }`
        );
      }
      return internalHostError(
        502,
        `${props.host}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
