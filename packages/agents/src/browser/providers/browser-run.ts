/**
 * The Browser Run provider: `browserRun(env.BROWSER, options)` and the
 * adapter that runs a {@link Browser}'s browser on Cloudflare Browser Run.
 */

import {
  acquireBrowserSession,
  type BrowserBinding,
  type BrowserSessionGuardrails,
  closeBrowserSession,
  connectBrowserSession,
  isMissingBrowserSession,
  listBrowserTargets
} from "../browser-run";
import {
  fetcherRoute,
  internalHostsSignature,
  validateInternalHosts,
  type AnyInternalHost,
  type InternalHostsOptions
} from "../internal-hosts";
import { createLiveView } from "../live-view";
import { loadCdpSpec } from "../spec";
import {
  BrowserSessionGoneError,
  type BrowserProviderAdapter,
  type InternalHostOwner
} from "./provider-adapter";

/**
 * Default `keep_alive` for a `Browser` on Browser Run: 10 minutes. Long
 * enough to survive quiet spells between agent turns, while an abandoned
 * browser bills for at most 10 idle minutes (a whole day of Workers Free
 * browser time).
 */
export const BROWSER_SESSION_KEEP_ALIVE_DEFAULT_MS = 600_000;

/**
 * Browser Run's `keep_alive` maximum: 20 minutes. Browser Run rejects
 * anything longer.
 */
export const BROWSER_SESSION_KEEP_ALIVE_MAX_MS = 1_200_000;

/**
 * Browser Run settings applied every time a browser is created — including
 * when a lost browser is replaced — so options like guardrails survive a
 * restart.
 */
export interface BrowserRunOptions<S = Record<string, unknown>> {
  /**
   * Platform `keep_alive` in milliseconds: how long an idle browser lives.
   * Defaults to {@link BROWSER_SESSION_KEEP_ALIVE_DEFAULT_MS} (10 minutes).
   * Browser Run accepts up to {@link BROWSER_SESSION_KEEP_ALIVE_MAX_MS}
   * (20 minutes).
   */
  keepAliveMs?: number;
  /** Opt into Browser Run session recording (rrweb capture). */
  recording?: boolean;
  /**
   * Hostname guardrails, fixed at launch for every connection. They don't
   * apply to `internalHosts`: `allowedDomains: []` leaves the browser able
   * to open internal hostnames only.
   */
  guardrails?: BrowserSessionGuardrails;
  /**
   * Hostnames only this browser can open, served by your agent or a Worker
   * instead of the internet. Plain http on port 80; no HTTPS or WebSockets.
   * Deployed Workers only: in local dev the browser starts without them.
   *
   * @example
   * ```ts
   * browserRun(this.env.BROWSER, {
   *   internalHosts: {
   *     router: this.ctx.exports.InternalHostRouter,
   *     hosts: {
   *       "preview.internal": {
   *         description: "A dev server in your sandbox",
   *         target: z.object({ port: z.number().int() }),
   *         fetch: (request, { port }) => this.sandboxPort(port, request)
   *       }
   *     }
   *   }
   * });
   * ```
   */
  internalHosts?: InternalHostsOptions<S>;
}

/** A {@link Browser} provider backed by Cloudflare Browser Run. */
export interface BrowserRunProvider {
  readonly kind: "browser-run";
  readonly binding: BrowserBinding;
  readonly options: BrowserRunOptions;
}

/**
 * Run the browser on Cloudflare Browser Run.
 *
 * @example
 * ```ts
 * new Browser({ provider: browserRun(env.BROWSER, { recording: true }) });
 * ```
 */
export function browserRun<const S extends Record<string, unknown> = {}>(
  binding: BrowserBinding,
  options: BrowserRunOptions<S> = {}
): BrowserRunProvider {
  const erased = options as BrowserRunOptions;
  if (erased.internalHosts) validateInternalHosts(erased.internalHosts);
  return { kind: "browser-run", binding, options: erased };
}

function isDataCloneError(error: unknown): boolean {
  return error instanceof Error && error.name === "DataCloneError";
}

/** One `outboundByHost` route per internal hostname. */
function internalHostRoutes(
  internalHosts: InternalHostsOptions,
  owner: InternalHostOwner
): Record<string, Fetcher> {
  const routes: Record<string, Fetcher> = {};
  const hosts = Object.entries(internalHosts.hosts) as [
    string,
    AnyInternalHost
  ][];
  for (const [host, config] of hosts) {
    if (config.fetcher) {
      routes[host] = fetcherRoute(config.fetcher);
      continue;
    }
    // validateInternalHosts made sure a fetch host has a router.
    routes[host] = internalHosts.router!({
      props: { v: 1, ...owner, host }
    });
  }
  return routes;
}

/** The code behind {@link browserRun}. */
export function browserRunAdapter(
  provider: BrowserRunProvider
): BrowserProviderAdapter {
  const { binding, options } = provider;
  // Options are read on every use, like `recording` and `guardrails` below.
  const keepAliveMs = () =>
    options.keepAliveMs ?? BROWSER_SESSION_KEEP_ALIVE_DEFAULT_MS;

  return {
    get keepAliveMs() {
      return keepAliveMs();
    },

    internalHosts: options.internalHosts,
    internalHostsSignature: internalHostsSignature(options.internalHosts),

    async create(context) {
      const { internalHosts } = options;
      if (internalHosts && !context?.owner) {
        throw new Error(
          "Internal hostnames need the Browser installed with Lifecycle.use() on a top-level agent"
        );
      }
      try {
        return await acquireBrowserSession(binding, {
          keepAliveMs: keepAliveMs(),
          recording: options.recording,
          guardrails: options.guardrails,
          ...(internalHosts && context?.owner
            ? {
                outboundByHost: internalHostRoutes(internalHosts, context.owner)
              }
            : {})
        });
      } catch (error) {
        if (internalHosts && isDataCloneError(error)) {
          throw new Error(
            "Browser Run couldn't take the internal hostname routes: a fetcher must be a service binding or an entrypoint of this Worker (this.ctx.exports.Name), not a Durable Object stub or a Dynamic Worker",
            { cause: error }
          );
        }
        throw error;
      }
    },

    async isAlive(sessionId) {
      try {
        await listBrowserTargets(binding, sessionId);
        return true;
      } catch (error) {
        if (isMissingBrowserSession(error)) return false;
        throw error;
      }
    },

    async connect(sessionId, connectOptions) {
      try {
        return await connectBrowserSession(binding, sessionId, connectOptions);
      } catch (error) {
        if (isMissingBrowserSession(error)) {
          throw new BrowserSessionGoneError(sessionId, { cause: error });
        }
        throw error;
      }
    },

    async close(sessionId) {
      try {
        await closeBrowserSession(binding, sessionId);
      } catch (error) {
        if (!isMissingBrowserSession(error)) throw error;
      }
    },

    spec(sessionId) {
      return loadCdpSpec({ browser: binding, sessionId });
    },

    async liveView(sessionId, mode) {
      try {
        const targets = await listBrowserTargets(binding, sessionId);
        return createLiveView(sessionId, targets, mode);
      } catch (error) {
        if (isMissingBrowserSession(error)) return undefined;
        throw error;
      }
    }
  };
}
